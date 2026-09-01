import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  stat,
  rename as renameFile,
} from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve } from "node:path";
import {
  tryParseWorkflowStateDto,
} from "@aacl/shared";
import type {
  ExecutionInstanceId,
  Timestamp,
  WorkflowId,
  WorkflowStateDto,
  WorkflowStateVersion,
} from "@aacl/shared";
import {
  coreFailure,
  type AssetResult,
  type CoreFailure,
  type WorkflowStateMutation,
  type WorkflowStateSeed,
} from "@aacl/core-domain";
import { writeAtomically, type Rename } from "../internal/atomic-write.ts";
import { portableFileName } from "../internal/portable-name.ts";
import { strictDecode } from "../internal/text.ts";

export type WorkflowStateStoreOptions = {
  readonly stateDirectory: string;
  readonly now?: () => Timestamp;
  readonly generateExecutionInstanceId?: () => ExecutionInstanceId;
  readonly rename?: Rename;
};

export type WorkflowStateStore = {
  readonly create: (seed: WorkflowStateSeed) => Promise<AssetResult<WorkflowStateDto>>;
  readonly get: (
    workflowId: WorkflowId,
    executionInstanceId: ExecutionInstanceId,
  ) => Promise<AssetResult<WorkflowStateDto>>;
  readonly compareAndSwap: (
    workflowId: WorkflowId,
    executionInstanceId: ExecutionInstanceId,
    expectedStateVersion: WorkflowStateVersion,
    mutation: WorkflowStateMutation,
  ) => Promise<AssetResult<WorkflowStateDto>>;
};

type StoredState = {
  readonly state: WorkflowStateDto;
  readonly mode: number;
};

const COLLISION_ATTEMPT_LIMIT = 8;

const stateFailure = (
  code: "invalid_request" | "not_found" | "conflict" | "unavailable" | "internal",
  message: string,
  path: readonly string[],
  detailCode: string,
): CoreFailure => coreFailure(code, message, [{
  path: [...path],
  code: detailCode,
  message,
}]);

const errorCode = (error: unknown): string | undefined => {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
};

const isContainedPath = (rootDirectory: string, targetPath: string): boolean => {
  const remainder = relative(rootDirectory, targetPath);
  return remainder !== "" && !isAbsolute(remainder) && remainder !== ".." && !remainder.startsWith(`..${"/"}`) && !remainder.startsWith(`..${"\\"}`);
};

/**
 * The contract guarantees only a non-empty string and leaves the character set to whoever maps
 * it onto a filename, so this store constrains filesystem portability and nothing else. The
 * `instance-` shape the default generator produces is that generator's convention, and a host
 * that injects its own generator is entitled to a different one.
 */
const validExecutionInstanceId = (value: ExecutionInstanceId): boolean => portableFileName(value);

const filePathFor = (
  workflowsDirectory: string,
  executionInstanceId: ExecutionInstanceId,
): string | undefined => {
  if (!validExecutionInstanceId(executionInstanceId)) return undefined;
  const target = resolve(join(workflowsDirectory, `${executionInstanceId}.json`));
  return isContainedPath(workflowsDirectory, target) ? target : undefined;
};

const invalidParsedState = (details: readonly { readonly path: readonly string[]; readonly code: string; readonly message: string }[]): AssetResult<never> => ({
  ok: false,
  failure: coreFailure("invalid_request", "The workflow state has an invalid shape.", details.map((item) => ({
    path: [...item.path],
    code: item.code,
    message: item.message,
  }))),
});

const inspectDirectoryComponents = async (directory: string): Promise<AssetResult<undefined>> => {
  const root = parse(directory).root;
  let current = root;
  for (const segment of directory.slice(root.length).split(/[\\/]/).filter((item) => item !== "")) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        return {
          ok: false,
          failure: stateFailure("invalid_request", "The workflow state path is not a regular directory.", ["stateDirectory"], "invalid_state_directory"),
        };
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { ok: true, value: undefined };
      return {
        ok: false,
        failure: stateFailure("unavailable", "The workflow state path could not be inspected.", ["stateDirectory"], "unavailable"),
      };
    }
  }
  return { ok: true, value: undefined };
};

const ensureDirectoryTree = async (stateDirectory: string, workflowsDirectory: string): Promise<AssetResult<undefined>> => {
  if (!isAbsolute(stateDirectory) || stateDirectory.trim() === "") {
    return {
      ok: false,
      failure: stateFailure("invalid_request", "The workflow state directory must be absolute.", ["stateDirectory"], "invalid_state_directory"),
    };
  }
  try {
    for (const directory of [stateDirectory, workflowsDirectory]) {
      const inspected = await inspectDirectoryComponents(directory);
      if (!inspected.ok) return inspected;
    }
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await mkdir(workflowsDirectory, { recursive: true, mode: 0o700 });
    for (const directory of [stateDirectory, workflowsDirectory]) {
      const root = parse(directory).root;
      let current = root;
      for (const segment of directory.slice(root.length).split(/[\\/]/).filter((item) => item !== "")) {
        current = join(current, segment);
        const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
          return {
            ok: false,
            failure: stateFailure("invalid_request", "The workflow state path is not a regular directory.", ["stateDirectory"], "invalid_state_directory"),
          };
        }
      }
    }
  } catch (error) {
    return {
      ok: false,
      failure: stateFailure(
        errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR" ? "invalid_request" : "unavailable",
        "The workflow state directory could not be prepared.",
        ["stateDirectory"],
        errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR" ? "invalid_state_directory" : "unavailable",
      ),
    };
  }
  return { ok: true, value: undefined };
};

const parseState = (document: string): AssetResult<WorkflowStateDto> => {
  let value: unknown;
  try {
    value = JSON.parse(document) as unknown;
  } catch {
    return {
      ok: false,
      failure: stateFailure("invalid_request", "The workflow state is not valid JSON.", ["workflowState"], "invalid_json"),
    };
  }
  const parsed = tryParseWorkflowStateDto(value);
  if (!parsed.ok) return invalidParsedState(parsed.error.details ?? []);
  return { ok: true, value: parsed.value };
};

const instanceMismatch = (): AssetResult<never> => ({
  ok: false,
  failure: stateFailure(
    "invalid_request",
    "The workflow state does not match its file name.",
    ["workflowState", "executionInstanceId"],
    "instance_id_mismatch",
  ),
});

const workflowMismatch = (): AssetResult<never> => ({
  ok: false,
  failure: stateFailure(
    "conflict",
    "The workflow state belongs to a different workflow definition.",
    ["workflowState", "workflowId"],
    "instance_workflow_mismatch",
  ),
});

// Write serialization is per state directory and spans every store instance in this Core
// process. The key is the lexical resolve of the directory, matching the asset store, so a
// symlink alias or a case variant on a case-insensitive filesystem is a different key (#60).
const workflowStateChains = new Map<string, Promise<unknown>>();

export const createWorkflowStateStore = async (
  options: WorkflowStateStoreOptions,
): Promise<AssetResult<WorkflowStateStore>> => {
  const workflowsDirectory = join(options.stateDirectory, "workflows");
  const chainKey = resolve(workflowsDirectory);
  const prepared = await ensureDirectoryTree(options.stateDirectory, workflowsDirectory);
  if (!prepared.ok) return prepared;

  const now = options.now ?? (() => new Date().toISOString() as Timestamp);
  const generateExecutionInstanceId = options.generateExecutionInstanceId ?? (() => `instance-${randomUUID()}` as ExecutionInstanceId);
  const rename = options.rename ?? renameFile;

  const inWriteChain = async <Value>(operation: () => Promise<Value>): Promise<Value> => {
    const previous = workflowStateChains.get(chainKey) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    workflowStateChains.set(chainKey, current);
    try {
      return await current;
    } finally {
      if (workflowStateChains.get(chainKey) === current) workflowStateChains.delete(chainKey);
    }
  };

  const readStoredState = async (
    workflowId: WorkflowId,
    executionInstanceId: ExecutionInstanceId,
  ): Promise<AssetResult<StoredState>> => {
    const targetPath = filePathFor(workflowsDirectory, executionInstanceId);
    if (targetPath === undefined) {
      return { ok: false, failure: stateFailure("invalid_request", "The execution instance id is not a valid state file name.", ["workflowState", "executionInstanceId"], "invalid_execution_instance_id") };
    }
    let targetInfo;
    try {
      targetInfo = await lstat(targetPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return { ok: false, failure: stateFailure("not_found", "The workflow state was not found.", ["workflowState", "executionInstanceId"], "state_not_found") };
      }
      return { ok: false, failure: stateFailure("unavailable", "The workflow state file could not be inspected.", ["workflowState", "executionInstanceId"], "unavailable") };
    }
    if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) {
      return { ok: false, failure: stateFailure("invalid_request", "The workflow state path is not a regular file.", ["workflowState", "executionInstanceId"], "state_file_not_a_file") };
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(targetPath);
    } catch {
      return { ok: false, failure: stateFailure("unavailable", "The workflow state file could not be read.", ["workflowState", "executionInstanceId"], "unavailable") };
    }
    // Fatal decoding, as every other reader of a managed file does. A lenient decode turns a
    // malformed byte into U+FFFD, which still parses and still validates, so `get` would return
    // an identifier that differs from the bytes on disk and the next write would make that
    // substitution permanent.
    const decoded = strictDecode(bytes, ["workflowState"], "workflow state");
    if (!decoded.ok) return decoded;
    const parsed = parseState(decoded.value);
    if (!parsed.ok) return parsed;
    if (parsed.value.executionInstanceId !== executionInstanceId) return instanceMismatch();
    if (parsed.value.workflowId !== workflowId) return workflowMismatch();
    let mode: number;
    try {
      mode = (await stat(targetPath)).mode & 0o777;
    } catch {
      return { ok: false, failure: stateFailure("unavailable", "The workflow state file could not be inspected.", ["workflowState", "executionInstanceId"], "unavailable") };
    }
    return { ok: true, value: { state: parsed.value, mode } };
  };

  const create = (seed: WorkflowStateSeed): Promise<AssetResult<WorkflowStateDto>> => inWriteChain(async () => {
    // The generator is injectable, so a deterministic or coarse one can hand back an id whose
    // file already exists on every attempt. This runs inside the per-directory write chain, so
    // retrying forever would wedge every later create and compare-and-swap for that directory.
    for (let attempt = 0; attempt < COLLISION_ATTEMPT_LIMIT; attempt += 1) {
      const executionInstanceId = generateExecutionInstanceId();
      const targetPath = filePathFor(workflowsDirectory, executionInstanceId);
      if (targetPath === undefined) {
        return { ok: false, failure: stateFailure("invalid_request", "The generated execution instance id is not a valid state file name.", ["workflowState", "executionInstanceId"], "invalid_execution_instance_id") };
      }
      try {
        await lstat(targetPath);
        continue;
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          return { ok: false, failure: stateFailure("unavailable", "The workflow state target could not be inspected.", ["workflowState", "executionInstanceId"], "unavailable") };
        }
      }

      const candidate = {
        workflowId: seed.workflowId,
        executionInstanceId,
        stateVersion: 0 as WorkflowStateVersion,
        currentStageId: seed.currentStageId,
        entryRoleId: seed.entryRoleId,
        currentRoleId: seed.currentRoleId,
        linkedAgentExecutionIds: [...seed.linkedAgentExecutionIds],
        linkedSnapshotIds: [...seed.linkedSnapshotIds],
        updatedAt: now(),
      };
      const parsed = tryParseWorkflowStateDto(candidate);
      if (!parsed.ok) return invalidParsedState(parsed.error.details ?? []);
      let document: string;
      try {
        document = JSON.stringify(parsed.value);
      } catch {
        return { ok: false, failure: stateFailure("internal", "The workflow state could not be serialized.", ["workflowState"], "serialization_failed") };
      }
      if (!await writeAtomically(targetPath, document, rename, 0o600)) {
        return { ok: false, failure: stateFailure("unavailable", "The workflow state could not be saved atomically.", ["workflowState", "executionInstanceId"], "unavailable") };
      }
      return { ok: true, value: parsed.value };
    }
    return { ok: false, failure: stateFailure("conflict", "A free execution instance id could not be generated.", ["workflowState", "executionInstanceId"], "execution_instance_id_exhausted") };
  });

  const get = async (workflowId: WorkflowId, executionInstanceId: ExecutionInstanceId): Promise<AssetResult<WorkflowStateDto>> => {
    const result = await readStoredState(workflowId, executionInstanceId);
    return result.ok ? { ok: true, value: result.value.state } : result;
  };

  const compareAndSwap = (
    workflowId: WorkflowId,
    executionInstanceId: ExecutionInstanceId,
    expectedStateVersion: WorkflowStateVersion,
    mutation: WorkflowStateMutation,
  ): Promise<AssetResult<WorkflowStateDto>> => inWriteChain(async () => {
    const current = await readStoredState(workflowId, executionInstanceId);
    if (!current.ok) return current;
    if (current.value.state.stateVersion !== expectedStateVersion) {
      return {
        ok: false,
        failure: coreFailure("conflict", "The workflow state version no longer matches the update precondition.", [{
          path: ["workflowState", "stateVersion"],
          code: "state_version_conflict",
          message: "The workflow state version no longer matches the update precondition.",
        }]),
      };
    }
    if (mutation.workflowId !== workflowId || mutation.executionInstanceId !== executionInstanceId) {
      return { ok: false, failure: stateFailure("invalid_request", "The workflow state update identity does not match the requested state.", ["workflowState"], "state_identity_mismatch") };
    }
    if (mutation.stateVersion !== expectedStateVersion + 1) {
      return { ok: false, failure: stateFailure("invalid_request", "The workflow state update must advance the version by one.", ["workflowState", "stateVersion"], "invalid_state_version") };
    }
    const candidate = {
      workflowId: mutation.workflowId,
      executionInstanceId: mutation.executionInstanceId,
      stateVersion: mutation.stateVersion,
      currentStageId: mutation.currentStageId,
      entryRoleId: mutation.entryRoleId,
      currentRoleId: mutation.currentRoleId,
      linkedAgentExecutionIds: [...mutation.linkedAgentExecutionIds],
      linkedSnapshotIds: [...mutation.linkedSnapshotIds],
      updatedAt: now(),
    };
    const parsed = tryParseWorkflowStateDto(candidate);
    if (!parsed.ok) return invalidParsedState(parsed.error.details ?? []);
    let document: string;
    try {
      document = JSON.stringify(parsed.value);
    } catch {
      return { ok: false, failure: stateFailure("internal", "The workflow state could not be serialized.", ["workflowState"], "serialization_failed") };
    }
    const targetPath = filePathFor(workflowsDirectory, executionInstanceId);
    if (targetPath === undefined) {
      return { ok: false, failure: stateFailure("invalid_request", "The execution instance id is not a valid state file name.", ["workflowState", "executionInstanceId"], "invalid_execution_instance_id") };
    }
    if (!await writeAtomically(targetPath, document, rename, current.value.mode)) {
      return { ok: false, failure: stateFailure("unavailable", "The workflow state could not be saved atomically.", ["workflowState", "executionInstanceId"], "unavailable") };
    }
    return { ok: true, value: parsed.value };
  });

  return { ok: true, value: { create, get, compareAndSwap } };
};
