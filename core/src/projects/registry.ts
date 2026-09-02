import { homedir } from "node:os";
import { lstat, mkdir, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tryParseProjectMarkerDto } from "@aacl/shared";
import type { ProjectId } from "@aacl/shared";
import { coreFailure, type AssetResult } from "@aacl/core-domain";
import { writeAtomically, type BeforeRename } from "../internal/atomic-write.ts";
import { withFileLock, type FileLockGuard, type FileLockOptions } from "../internal/file-lock.ts";
import { readRegularUtf8 } from "../internal/regular-file.ts";

export const PROJECT_REGISTRY_SCHEMA_VERSION = 1;

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
  readonly reconcile: () => Promise<AssetResult<undefined>>;
};

export type ProjectRegistryOptions = {
  readonly lock?: FileLockOptions;
  readonly beforeWrite?: () => Promise<void>;
  readonly beforeRename?: () => Promise<void>;
};

const registryFailure = (
  code: "invalid_request" | "conflict" | "unavailable" | "internal",
  message: string,
  detailCode: string,
): AssetResult<never> => ({
  ok: false,
  failure: coreFailure(code, message, [{ path: ["projectRegistry"], code: detailCode, message }]),
});

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
};

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

type MarkerObservation =
  | { readonly status: "missing" }
  | { readonly status: "valid"; readonly projectId: ProjectId }
  | { readonly status: "invalid" }
  | { readonly status: "unavailable" };

const markerAt = async (projectRoot: string): Promise<MarkerObservation> => {
  const projectDirectory = join(projectRoot, ".aacl");
  const markerPath = join(projectDirectory, "project.json");
  try {
    const directoryInfo = await lstat(projectDirectory);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) return { status: "invalid" };
  } catch (error) {
    return errorCode(error) === "ENOENT" ? { status: "missing" } : { status: "unavailable" };
  }

  const read = await readRegularUtf8(markerPath);
  if (read.status === "missing") return { status: "missing" };
  if (read.status === "not_regular") return { status: "invalid" };
  if (read.status === "unavailable") return { status: "unavailable" };
  try {
    const parsed = tryParseProjectMarkerDto(JSON.parse(read.contents) as unknown);
    return parsed.ok ? { status: "valid", projectId: parsed.value.projectId } : { status: "invalid" };
  } catch {
    return { status: "invalid" };
  }
};

export const defaultProjectRegistryPath = (homeDirectory = homedir()): string =>
  join(homeDirectory, ".aacl-state", "project-registry.json");

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

    reconcile: () => runLocked<undefined>(async (assertOwned): Promise<AssetResult<undefined>> => {
      const loaded = await readRegistry(normalizedRegistryPath);
      if (!loaded.ok) return loaded;
      if (loaded.value.document.entries.length === 0 && loaded.value.mode === undefined) {
        return { ok: true, value: undefined };
      }
      const entries: RegistryEntry[] = [];
      for (const entry of loaded.value.document.entries) {
        const observed = await markerAt(entry.projectRoot);
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
      if (JSON.stringify(next) === JSON.stringify(loaded.value.document)) return { ok: true, value: undefined };
      return persistRegistry(assertOwned, next, loaded.value.mode);
    }),
  };
};
