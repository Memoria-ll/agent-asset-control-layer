import { homedir } from "node:os";
import { lstat, mkdir, readFile, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tryParseProjectMarkerDto } from "@aacl/shared";
import type { ProjectId } from "@aacl/shared";
import { coreFailure, type AssetResult } from "@aacl/core-domain";
import { writeAtomically } from "../internal/atomic-write.ts";

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
    && typeof entry.projectId === "string"
    && entry.projectId.length > 0
    && (entry.state === "pending" || entry.state === "bound" || entry.state === "mismatch")
    && keys.length === expectedKeys.length
    && keys.every((key, index) => key === expectedKeys[index]);
  if (!base) return false;
  if (entry.state === "mismatch") {
    return typeof entry.markerProjectId === "string" && entry.markerProjectId.length > 0;
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
  try {
    const [contents, info] = await Promise.all([readFile(registryPath, "utf8"), lstat(registryPath)]);
    if (info.isSymbolicLink() || !info.isFile()) return registryFailure("invalid_request", "The Project Registry is not a regular file.", "invalid_registry_file");
    const document = parseRegistry(contents);
    return document === undefined
      ? registryFailure("invalid_request", "The Project Registry has an invalid shape.", "invalid_registry")
      : { ok: true, value: { document, mode: info.mode } };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { ok: true, value: { document: emptyRegistry() } };
    return registryFailure("unavailable", "The Project Registry could not be read.", "unavailable");
  }
};

const writeRegistry = async (
  registryPath: string,
  document: RegistryDocument,
  mode?: number,
): Promise<AssetResult<undefined>> => {
  try {
    await mkdir(dirname(registryPath), { recursive: true, mode: 0o700 });
    const written = await writeAtomically(
      registryPath,
      `${JSON.stringify(document, null, 2)}\n`,
      rename,
      mode ?? 0o600,
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

const markerAt = async (projectRoot: string): Promise<ProjectId | undefined> => {
  const projectDirectory = join(projectRoot, ".aacl");
  const markerPath = join(projectDirectory, "project.json");
  try {
    const directoryInfo = await lstat(projectDirectory);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) return undefined;
    const info = await lstat(markerPath);
    if (info.isSymbolicLink() || !info.isFile()) return undefined;
    const parsed = tryParseProjectMarkerDto(JSON.parse(await readFile(markerPath, "utf8")) as unknown);
    return parsed.ok ? parsed.value.projectId : undefined;
  } catch {
    return undefined;
  }
};

export const defaultProjectRegistryPath = (homeDirectory = homedir()): string =>
  join(homeDirectory, ".aacl", "project-registry.json");

export const createProjectRegistry = (registryPath: string): ProjectRegistry => {
  const normalizedRegistryPath = resolve(registryPath);

  return {
    prepare: (workspacePath, projectRoot, proposedProjectId) => serialized(normalizedRegistryPath, async () => {
      const loaded = await readRegistry(normalizedRegistryPath);
      if (!loaded.ok) return loaded;
      const normalizedWorkspace = resolve(workspacePath);
      const existing = loaded.value.document.entries.find((entry) => entry.workspacePath === normalizedWorkspace);
      if (existing?.state === "mismatch") {
        return registryFailure("conflict", "The workspace conflicts with its registered Project identity.", "project_id_mismatch");
      }
      if (existing !== undefined) return { ok: true, value: existing.projectId };

      const entry: RegistryEntry = {
        workspacePath: normalizedWorkspace,
        projectRoot: resolve(projectRoot),
        projectId: proposedProjectId,
        state: "pending",
      };
      const saved = await writeRegistry(normalizedRegistryPath, {
        schemaVersion: 1,
        entries: [...loaded.value.document.entries, entry],
      }, loaded.value.mode);
      return saved.ok ? { ok: true, value: proposedProjectId } : saved;
    }),

    observe: (workspacePath, projectRoot, markerProjectId) => serialized(normalizedRegistryPath, async () => {
      const loaded = await readRegistry(normalizedRegistryPath);
      if (!loaded.ok) return loaded;
      const normalizedWorkspace = resolve(workspacePath);
      const existing = loaded.value.document.entries.find((entry) => entry.workspacePath === normalizedWorkspace);
      const registryProjectId = existing?.projectId ?? markerProjectId;
      const observation: RegistryObservation = registryProjectId === markerProjectId
        ? { status: "bound" }
        : { status: "mismatch", registryProjectId };
      const replacement: RegistryEntry = observation.status === "bound"
        ? {
            workspacePath: normalizedWorkspace,
            projectRoot: resolve(projectRoot),
            projectId: registryProjectId,
            state: "bound",
          }
        : {
            workspacePath: normalizedWorkspace,
            projectRoot: resolve(projectRoot),
            projectId: registryProjectId,
            state: "mismatch",
            markerProjectId,
          };
      const entries = existing === undefined
        ? [...loaded.value.document.entries, replacement]
        : loaded.value.document.entries.map((entry) => entry.workspacePath === normalizedWorkspace ? replacement : entry);
      const saved = await writeRegistry(normalizedRegistryPath, { schemaVersion: 1, entries }, loaded.value.mode);
      return saved.ok ? { ok: true, value: observation } : saved;
    }),

    reconcile: () => serialized(normalizedRegistryPath, async () => {
      const loaded = await readRegistry(normalizedRegistryPath);
      if (!loaded.ok) return loaded;
      if (loaded.value.document.entries.length === 0 && loaded.value.mode === undefined) {
        return { ok: true, value: undefined };
      }
      const entries: RegistryEntry[] = [];
      for (const entry of loaded.value.document.entries) {
        const observed = await markerAt(entry.projectRoot);
        entries.push(observed === undefined
          ? { workspacePath: entry.workspacePath, projectRoot: entry.projectRoot, projectId: entry.projectId, state: "pending" }
          : observed === entry.projectId
            ? { workspacePath: entry.workspacePath, projectRoot: entry.projectRoot, projectId: entry.projectId, state: "bound" }
            : { workspacePath: entry.workspacePath, projectRoot: entry.projectRoot, projectId: entry.projectId, state: "mismatch", markerProjectId: observed });
      }
      const next: RegistryDocument = { schemaVersion: 1, entries };
      if (JSON.stringify(next) === JSON.stringify(loaded.value.document)) return { ok: true, value: undefined };
      return writeRegistry(normalizedRegistryPath, next, loaded.value.mode);
    }),
  };
};
