import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { mkdir, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { tryParseProjectMarkerDto } from "@aacl/shared";
import type { ProjectId } from "@aacl/shared";
import { coreFailure, type AssetResult } from "@aacl/core-domain";
import { writeAtomically, type BeforeRename } from "../internal/atomic-write.ts";
import { withFileLock, type FileLockGuard, type FileLockOptions } from "../internal/file-lock.ts";
import { readRegularUtf8 } from "../internal/regular-file.ts";
import type { MarkerObservation } from "./marker-observer.ts";

export type { MarkerObservation } from "./marker-observer.ts";

export const PROJECT_REGISTRY_SCHEMA_VERSION = 1;
export const PROJECT_REGISTRY_MARKER_RECONCILIATION_TIMEOUT_MS = 5_000;

type RegistryState = "pending" | "bound" | "mismatch";

type RegistryEntry = {
  readonly workspacePath: string;
  readonly projectRoot: string;
  readonly projectId: ProjectId;
  readonly state: RegistryState;
  readonly markerProjectId?: ProjectId;
};

type RegistryDocument = {
  readonly schemaVersion: 1;
  readonly entries: readonly RegistryEntry[];
};

export type RegistryObservation =
  | { readonly status: "bound" }
  | { readonly status: "mismatch"; readonly registryProjectId: ProjectId };

export type RegistryReconcileOutcome =
  | { readonly status: "complete" }
  | { readonly status: "degraded"; readonly reason: "timeout" };

export type ProjectRegistry = {
  readonly prepare: (
    workspacePath: string,
    projectRoot: string,
    proposedProjectId: ProjectId,
  ) => Promise<AssetResult<ProjectId>>;
  readonly observe: (
    workspacePath: string,
    projectRoot: string,
    markerProjectId: ProjectId,
  ) => Promise<AssetResult<RegistryObservation>>;
  readonly reconcile: () => Promise<AssetResult<RegistryReconcileOutcome>>;
};

export type ProjectRegistryOptions = {
  readonly lock?: FileLockOptions;
  readonly beforeWrite?: () => Promise<void>;
  readonly beforeRename?: () => Promise<void>;
  readonly markerObservationWorkerPath?: string;
  readonly markerReconciliationTimeoutMs?: number;
};

const registryFailure = (
  code: "invalid_request" | "conflict" | "unavailable" | "internal",
  message: string,
  detailCode: string,
): AssetResult<never> => ({
  ok: false,
  failure: coreFailure(code, message, [{ path: ["projectRegistry"], code: detailCode, message }]),
});

const isProjectId = (value: unknown): value is ProjectId =>
  typeof value === "string"
  && tryParseProjectMarkerDto({ schemaVersion: 1, projectId: value }).ok;

const isEntry = (value: unknown): value is RegistryEntry => {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  const keys = Object.keys(entry).sort();
  const expectedKeys = entry.state === "mismatch"
    ? ["markerProjectId", "projectId", "projectRoot", "state", "workspacePath"]
    : ["projectId", "projectRoot", "state", "workspacePath"];
  const base = typeof entry.workspacePath === "string"
    && isAbsolute(entry.workspacePath)
    && resolve(entry.workspacePath) === entry.workspacePath
    && typeof entry.projectRoot === "string"
    && isAbsolute(entry.projectRoot)
    && resolve(entry.projectRoot) === entry.projectRoot
    && isProjectId(entry.projectId)
    && (entry.state === "pending" || entry.state === "bound" || entry.state === "mismatch")
    && keys.length === expectedKeys.length
    && keys.every((key, index) => key === expectedKeys[index]);
  if (!base) return false;
  if (entry.state === "mismatch") {
    return isProjectId(entry.markerProjectId) && entry.markerProjectId !== entry.projectId;
  }
  return entry.markerProjectId === undefined;
};

const parseRegistry = (document: string): RegistryDocument | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(document) as unknown;
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).sort().join(",") !== "entries,schemaVersion") return undefined;
  if (candidate.schemaVersion !== PROJECT_REGISTRY_SCHEMA_VERSION || !Array.isArray(candidate.entries)) return undefined;
  if (!candidate.entries.every(isEntry)) return undefined;
  const paths = candidate.entries.map((entry) => resolve(entry.workspacePath));
  if (new Set(paths).size !== paths.length) return undefined;
  return { schemaVersion: 1, entries: candidate.entries };
};

const emptyRegistry = (): RegistryDocument => ({ schemaVersion: 1, entries: [] });

const readRegistry = async (registryPath: string): Promise<AssetResult<{ document: RegistryDocument; mode?: number }>> => {
  const read = await readRegularUtf8(registryPath);
  if (read.status === "missing") return { ok: true, value: { document: emptyRegistry() } };
  if (read.status === "not_regular") {
    return registryFailure("invalid_request", "The Project Registry is not a regular file.", "invalid_registry_file");
  }
  if (read.status === "unavailable") {
    return registryFailure("unavailable", "The Project Registry could not be read.", "unavailable");
  }
  const document = parseRegistry(read.contents);
  return document === undefined
    ? registryFailure("invalid_request", "The Project Registry has an invalid shape.", "invalid_registry")
    : { ok: true, value: { document, mode: read.mode & 0o777 } };
};

const writeRegistry = async (
  registryPath: string,
  document: RegistryDocument,
  mode?: number,
  beforeRename?: BeforeRename,
  assertBeforeRename?: FileLockGuard,
): Promise<AssetResult<undefined>> => {
  try {
    await mkdir(dirname(registryPath), { recursive: true, mode: 0o700 });
    const written = await writeAtomically(
      registryPath,
      `${JSON.stringify(document, null, 2)}\n`,
      rename,
      mode ?? 0o600,
      beforeRename,
      assertBeforeRename,
    );
    return written
      ? { ok: true, value: undefined }
      : registryFailure("unavailable", "The Project Registry could not be saved atomically.", "unavailable");
  } catch {
    return registryFailure("unavailable", "The Project Registry directory could not be prepared.", "unavailable");
  }
};

const registryChains = new Map<string, Promise<unknown>>();

const serialized = async <T>(registryPath: string, operation: () => Promise<T>): Promise<T> => {
  const key = resolve(registryPath);
  const previous = registryChains.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  registryChains.set(key, current);
  try {
    return await current;
  } finally {
    if (registryChains.get(key) === current) registryChains.delete(key);
  }
};

export const defaultProjectRegistryPath = (homeDirectory = homedir()): string =>
  join(homeDirectory, ".aacl-state", "project-registry.json");

const defaultMarkerObservationWorkerPath = fileURLToPath(
  new URL("./marker-observer-child.ts", import.meta.url),
);

const parseMarkerObservation = (value: unknown): MarkerObservation | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.status === "missing" || candidate.status === "invalid" || candidate.status === "unavailable") {
    return { status: candidate.status };
  }
  if (candidate.status === "valid" && isProjectId(candidate.projectId)) {
    return { status: "valid", projectId: candidate.projectId };
  }
  return undefined;
};

const observeMarkerInChild = (
  workerPath: string,
  projectRoot: string,
  timeoutMs: number,
): Promise<MarkerObservation | undefined> => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve(undefined);
  return new Promise<MarkerObservation | undefined>((resolveObservation) => {
    let child: ChildProcess | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let output = "";
    let observation: MarkerObservation | undefined;
    let protocolFailure = false;

    const clearTimer = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    const cleanupStreams = (): void => {
      child?.stdout?.removeListener("data", onStdout);
      child?.stderr?.removeListener("data", onStderr);
      child?.stdout?.removeListener("error", onStreamError);
      child?.stderr?.removeListener("error", onStreamError);
      child?.stdout?.destroy();
      child?.stderr?.destroy();
    };

    const cleanupChild = (): void => {
      clearTimer();
      cleanupStreams();
      child?.removeListener("error", onChildError);
      child?.removeListener("close", onChildClose);
    };

    const settle = (result: MarkerObservation | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimer();
      resolveObservation(result);
    };

    const consumeOutput = (final: boolean): void => {
      const lines = output.split("\n");
      output = final ? "" : (lines.pop() ?? "");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        let value: unknown;
        try {
          value = JSON.parse(trimmed) as unknown;
        } catch {
          protocolFailure = true;
          continue;
        }
        const parsed = parseMarkerObservation(value);
        if (parsed === undefined || observation !== undefined) {
          protocolFailure = true;
        } else {
          observation = parsed;
        }
      }
    };

    const onStdout = (chunk: string): void => {
      output += chunk;
      consumeOutput(false);
    };
    const onStderr = (): void => undefined;
    const onStreamError = (): void => undefined;
    const onChildError = (): void => {
      settle({ status: "unavailable" });
    };
    const onChildClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (!settled) {
        consumeOutput(true);
        settle(code === 0 && signal === null && !protocolFailure
          ? (observation ?? { status: "unavailable" })
          : { status: "unavailable" });
      }
      cleanupChild();
    };

    try {
      child = spawn(process.execPath, [resolve(workerPath), projectRoot], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      settle({ status: "unavailable" });
      return;
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.stdout?.on("error", onStreamError);
    child.stderr?.on("error", onStreamError);
    child.once("error", onChildError);
    child.once("close", onChildClose);
    timer = setTimeout(() => {
      if (settled) return;
      settle(undefined);
      cleanupStreams();
      child?.unref();
      try {
        if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      } catch {
        // The timeout result is already determined; process termination cannot change it.
      }
    }, timeoutMs);
  });
};

const withRegistryLock = async <T>(
  registryPath: string,
  lockOptions: FileLockOptions | undefined,
  operation: (assertOwned: FileLockGuard) => Promise<AssetResult<T>>,
): Promise<AssetResult<T>> => {
  try {
    return await withFileLock(`${registryPath}.lock`, operation, lockOptions);
  } catch {
    return registryFailure("unavailable", "The Project Registry lock could not be acquired.", "lock_unavailable");
  }
};

export const createProjectRegistry = (
  registryPath: string,
  options: ProjectRegistryOptions = {},
): ProjectRegistry => {
  const normalizedRegistryPath = resolve(registryPath);
  const markerObservationWorkerPath = resolve(
    options.markerObservationWorkerPath ?? defaultMarkerObservationWorkerPath,
  );
  const markerReconciliationTimeoutMs = options.markerReconciliationTimeoutMs
    ?? PROJECT_REGISTRY_MARKER_RECONCILIATION_TIMEOUT_MS;
  const runLocked = <T>(operation: (assertOwned: FileLockGuard) => Promise<AssetResult<T>>): Promise<AssetResult<T>> =>
    serialized<AssetResult<T>>(
      normalizedRegistryPath,
      () => withRegistryLock<T>(normalizedRegistryPath, options.lock, operation),
    );
  const persistRegistry = async (
    assertOwned: FileLockGuard,
    document: RegistryDocument,
    mode?: number,
  ): Promise<AssetResult<undefined>> => {
    await options.beforeWrite?.();
    return writeRegistry(normalizedRegistryPath, document, mode, options.beforeRename, assertOwned);
  };

  return {
    prepare: (workspacePath, projectRoot, proposedProjectId) => runLocked<ProjectId>(async (assertOwned): Promise<AssetResult<ProjectId>> => {
      if (!isProjectId(proposedProjectId)) {
        return registryFailure("internal", "The proposed Project ID is invalid.", "invalid_project_id");
      }
      const loaded = await readRegistry(normalizedRegistryPath);
      if (!loaded.ok) return loaded;
      const normalizedWorkspace = resolve(workspacePath);
      const normalizedRoot = resolve(projectRoot);
      const existing = loaded.value.document.entries.find((entry) => entry.workspacePath === normalizedWorkspace);
      if (existing?.state === "mismatch") {
        return registryFailure("conflict", "The workspace conflicts with its registered Project identity.", "project_id_mismatch");
      }
      if (existing?.state === "pending") return { ok: true, value: existing.projectId };

      const entry: RegistryEntry = {
        workspacePath: normalizedWorkspace,
        projectRoot: normalizedRoot,
        projectId: proposedProjectId,
        state: "pending",
      };
      const entries = existing === undefined
        ? [...loaded.value.document.entries, entry]
        : loaded.value.document.entries.map((candidate) => candidate.workspacePath === normalizedWorkspace ? entry : candidate);
      const saved = await persistRegistry(assertOwned, {
        schemaVersion: 1,
        entries,
      }, loaded.value.mode);
      return saved.ok ? { ok: true, value: proposedProjectId } : saved;
    }),

    observe: (workspacePath, projectRoot, markerProjectId) => runLocked<RegistryObservation>(async (assertOwned): Promise<AssetResult<RegistryObservation>> => {
      if (!isProjectId(markerProjectId)) {
        return registryFailure("invalid_request", "The Project Marker ID is invalid.", "invalid_project_id");
      }
      const loaded = await readRegistry(normalizedRegistryPath);
      if (!loaded.ok) return loaded;
      const normalizedWorkspace = resolve(workspacePath);
      const normalizedRoot = resolve(projectRoot);
      const existing = loaded.value.document.entries.find((entry) => entry.workspacePath === normalizedWorkspace);
      const registryProjectId = existing?.projectId ?? markerProjectId;
      const observation: RegistryObservation = registryProjectId === markerProjectId
        ? { status: "bound" }
        : { status: "mismatch", registryProjectId };
      const replacement: RegistryEntry = observation.status === "bound"
          ? {
            workspacePath: normalizedWorkspace,
            projectRoot: normalizedRoot,
            projectId: registryProjectId,
            state: "bound",
          }
          : {
            workspacePath: normalizedWorkspace,
            projectRoot: normalizedRoot,
            projectId: registryProjectId,
            state: "mismatch",
            markerProjectId,
          };
      const entries = existing === undefined
        ? [...loaded.value.document.entries, replacement]
        : loaded.value.document.entries.map((entry) => entry.workspacePath === normalizedWorkspace ? replacement : entry);
      const saved = await persistRegistry(assertOwned, { schemaVersion: 1, entries }, loaded.value.mode);
      return saved.ok ? { ok: true, value: observation } : saved;
    }),

    reconcile: () => runLocked<RegistryReconcileOutcome>(async (assertOwned): Promise<AssetResult<RegistryReconcileOutcome>> => {
      const loaded = await readRegistry(normalizedRegistryPath);
      if (!loaded.ok) return loaded;
      if (loaded.value.document.entries.length === 0 && loaded.value.mode === undefined) {
        return { ok: true, value: { status: "complete" } };
      }
      const entries: RegistryEntry[] = [];
      const deadline = performance.now() + Math.max(0, markerReconciliationTimeoutMs);
      for (const entry of loaded.value.document.entries) {
        const remaining = deadline - performance.now();
        const observed = await observeMarkerInChild(markerObservationWorkerPath, entry.projectRoot, remaining);
        if (observed === undefined) {
          return { ok: true, value: { status: "degraded", reason: "timeout" } };
        }
        if (observed.status === "missing") {
          if (entry.state === "pending") entries.push(entry);
          continue;
        }
        if (observed.status !== "valid") {
          entries.push(entry);
          continue;
        }
        entries.push(observed.projectId === entry.projectId
          ? { workspacePath: entry.workspacePath, projectRoot: entry.projectRoot, projectId: entry.projectId, state: "bound" }
          : {
              workspacePath: entry.workspacePath,
              projectRoot: entry.projectRoot,
              projectId: entry.projectId,
              state: "mismatch",
              markerProjectId: observed.projectId,
            });
      }
      const next: RegistryDocument = { schemaVersion: 1, entries };
      if (JSON.stringify(next) === JSON.stringify(loaded.value.document)) {
        return { ok: true, value: { status: "complete" } };
      }
      const saved = await persistRegistry(assertOwned, next, loaded.value.mode);
      return saved.ok ? { ok: true, value: { status: "complete" } } : saved;
    }),
  };
};
