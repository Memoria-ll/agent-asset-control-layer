import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, rmdir, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  createProjectMarkerDto,
  tryParseProjectMarkerDto,
} from "@aacl/shared";
import type {
  ProjectDiscoveryDto,
  ProjectId,
  ProjectInfoDto,
  ProjectMarkerDto,
} from "@aacl/shared";
import { coreFailure, type AssetResult, type CoreFailure } from "@aacl/core-domain";
import type { ProjectRegistry } from "./registry.ts";
import {
  FileIdentityError,
  assertDirectoryIdentity,
  assertRegularFileIdentity,
  fileIdentityOf,
  sameFileIdentity,
  type FileIdentity,
} from "../internal/fs-identity.ts";
import {
  readMarkerInDirectory,
  type MarkerSource,
} from "../internal/project-marker.ts";

export const PROJECT_DIRECTORY_NAME = ".aacl";
export const PROJECT_MARKER_FILE_NAME = "project.json";

export type ProjectService = {
  readonly initialize: (projectRoot: string) => Promise<AssetResult<ProjectInfoDto>>;
  readonly discover: (workspacePath: string) => Promise<AssetResult<ProjectDiscoveryDto>>;
};

export type ProjectServiceOptions = {
  readonly registry: ProjectRegistry;
  /** The service composes the `project-` prefix and accepts only the random suffix. */
  readonly newProjectSuffix?: () => string;
  readonly afterMarkerWritten?: () => Promise<void>;
  readonly unlinkPath?: (path: string) => Promise<void>;
  readonly statPath?: StatPath;
  readonly beforeMarkerDirectoryFreshStat?: () => void | Promise<void>;
  readonly afterMarkerDirectoryFreshStat?: () => void | Promise<void>;
  readonly beforeMarkerTemporaryOpen?: () => void | Promise<void>;
  readonly afterMarkerTemporaryOpen?: () => void | Promise<void>;
  readonly beforeMarkerLink?: () => void | Promise<void>;
  readonly afterMarkerLink?: () => void | Promise<void>;
};

type StatPath = (path: string) => Promise<{ readonly isDirectory: () => boolean }>;

type MarkerRead =
  | { readonly status: "missing_directory" | "missing_marker" }
  | { readonly status: "valid"; readonly marker: ProjectMarkerDto; readonly source: MarkerSource }
  | { readonly status: "invalid"; readonly failure: DiscoveryFailure };

type FailureWithCode<Code extends CoreFailure["code"]> = Omit<CoreFailure, "code"> & {
  readonly code: Code;
};

type DiscoveryFailure = FailureWithCode<"invalid_request" | "unavailable">;

const projectFailure = <Code extends "invalid_request" | "conflict" | "unavailable" | "internal">(
  code: Code,
  message: string,
  path: readonly string[],
  detailCode: string,
): FailureWithCode<Code> => coreFailure(code, message, [{ path: [...path], code: detailCode, message }]) as FailureWithCode<Code>;

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
};

const sourceFailure = (error: unknown, unavailableMessage: string): DiscoveryFailure => {
  if (error instanceof FileIdentityError && error.kind === "directory") {
    return projectFailure("invalid_request", "The .aacl path is not a regular directory.", ["projectRoot"], "invalid_project_directory");
  }
  if (error instanceof FileIdentityError && error.kind === "file") {
    return projectFailure("invalid_request", "The Project Marker is not a regular file.", ["projectMarker"], "invalid_marker_file");
  }
  return projectFailure("unavailable", unavailableMessage, ["projectMarker"], "unavailable");
};

const invalidDiscovery = (
  workspacePath: string,
  projectRoot: string,
  failure: DiscoveryFailure,
): ProjectDiscoveryDto => ({
  status: "invalid",
  workspacePath,
  projectRoot,
  failure: {
    code: failure.code,
    message: failure.message,
    ...(failure.details === undefined ? {} : { details: failure.details.map((detail) => ({ ...detail, path: [...detail.path] })) }),
  },
});

const readMarker = async (
  projectDirectory: string,
  beforeDirectoryFreshStat?: () => void | Promise<void>,
  afterDirectoryFreshStat?: () => void | Promise<void>,
): Promise<MarkerRead> => {
  const markerReadOptions = beforeDirectoryFreshStat === undefined && afterDirectoryFreshStat === undefined
    ? {}
    : {
        ...(beforeDirectoryFreshStat === undefined ? {} : { beforeDirectoryFreshStat }),
        ...(afterDirectoryFreshStat === undefined ? {} : { afterDirectoryFreshStat }),
      };
  const read = await readMarkerInDirectory(
    projectDirectory,
    join(projectDirectory, PROJECT_MARKER_FILE_NAME),
    markerReadOptions,
  );
  if (read.status === "missing_directory" || read.status === "missing_marker") return read;
  if (read.status === "invalid_directory") {
    return {
      status: "invalid",
      failure: projectFailure("invalid_request", "The .aacl path is not a regular directory.", ["projectRoot"], "invalid_project_directory"),
    };
  }
  if (read.status === "unavailable_directory") {
    return {
      status: "invalid",
      failure: projectFailure("unavailable", "The .aacl directory could not be inspected.", ["projectRoot"], "unavailable"),
    };
  }
  if (read.status === "invalid_marker") {
    return {
      status: "invalid",
      failure: projectFailure("invalid_request", "The Project Marker is not a regular file.", ["projectMarker"], "invalid_marker_file"),
    };
  }
  if (read.status === "unavailable_marker") {
    return {
      status: "invalid",
      failure: projectFailure("unavailable", "The Project Marker could not be read.", ["projectMarker"], "unavailable"),
    };
  }

  try {
    const parsed = tryParseProjectMarkerDto(JSON.parse(read.contents) as unknown);
    if (!parsed.ok) {
      return {
        status: "invalid",
        failure: projectFailure("invalid_request", "The Project Marker has an invalid shape.", ["projectMarker"], "invalid_marker"),
      };
    }
    return { status: "valid", marker: parsed.value, source: read.source };
  } catch {
    return {
      status: "invalid",
      failure: projectFailure("invalid_request", "The Project Marker is not valid JSON.", ["projectMarker"], "invalid_json"),
    };
  }
};

const prepareProjectDirectory = async (
  projectRoot: string,
): Promise<AssetResult<{ readonly path: string; readonly created: boolean; readonly identity: FileIdentity }>> => {
  const projectDirectory = join(projectRoot, PROJECT_DIRECTORY_NAME);
  try {
    let info;
    try {
      info = await lstat(projectDirectory);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    if (info !== undefined && (info.isSymbolicLink() || !info.isDirectory())) {
      return {
        ok: false,
        failure: projectFailure("invalid_request", "The .aacl path is not a regular directory.", ["projectRoot"], "invalid_project_directory"),
      };
    }
    if (info !== undefined) return { ok: true, value: { path: projectDirectory, created: false, identity: fileIdentityOf(info) } };
    let created = false;
    try {
      await mkdir(projectDirectory);
      created = true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    const prepared = await lstat(projectDirectory);
    if (prepared.isSymbolicLink() || !prepared.isDirectory()) {
      return {
        ok: false,
        failure: projectFailure("invalid_request", "The .aacl path is not a regular directory.", ["projectRoot"], "invalid_project_directory"),
      };
    }
    return { ok: true, value: { path: projectDirectory, created, identity: fileIdentityOf(prepared) } };
  } catch {
    return {
      ok: false,
      failure: projectFailure("unavailable", "The .aacl directory could not be prepared.", ["projectRoot"], "unavailable"),
    };
  }
};

const removeEmptyProjectDirectory = async (
  projectDirectory: string,
  created: boolean,
  directoryIdentity: FileIdentity,
): Promise<void> => {
  if (!created) return;
  try {
    assertDirectoryIdentity(projectDirectory, directoryIdentity);
    await rmdir(projectDirectory);
  } catch {
    // A concurrent initializer or a user-written asset keeps the directory in place.
  }
};

const writeMarkerExclusively = async (
  markerPath: string,
  marker: ProjectMarkerDto,
  unlinkPath: (path: string) => Promise<void>,
  directoryIdentity: FileIdentity,
  options: MarkerWriteOptions = {},
): Promise<"written" | "exists" | "failed"> => {
  const projectDirectory = dirname(markerPath);
  const temporaryPath = join(dirname(markerPath), `.aacl.${randomUUID()}.tmp`);
  let markerCommitted = false;
  let temporaryIdentity: FileIdentity | undefined;
  let handle: FileHandle | undefined;
  const assertDirectory = (): void => assertDirectoryIdentity(projectDirectory, directoryIdentity);
  const assertTemporary = (): void => {
    if (temporaryIdentity === undefined) {
      throw new FileIdentityError("file", temporaryPath);
    }
    assertRegularFileIdentity(temporaryPath, temporaryIdentity);
  };
  const cleanupTemporary = async (): Promise<void> => {
    if (temporaryIdentity === undefined) return;
    try {
      assertDirectory();
      assertTemporary();
      await unlinkPath(temporaryPath);
    } catch {
      // A replacement directory or file must never be removed by stale cleanup.
    }
  };
  try {
    assertDirectory();
    await options.beforeTemporaryOpen?.();
    assertDirectory();
    handle = await open(temporaryPath, "wx", 0o644);
    const temporaryInfo = await handle.stat();
    if (!temporaryInfo.isFile()) throw new FileIdentityError("file", temporaryPath);
    temporaryIdentity = fileIdentityOf(temporaryInfo);
    assertDirectory();
    assertTemporary();
    await options.afterTemporaryOpen?.();
    assertDirectory();
    assertTemporary();
    await handle.writeFile(`${JSON.stringify(marker, null, 2)}\n`, "utf8");
    await handle.close();
    handle = undefined;
    await options.beforeMarkerLink?.();
    assertDirectory();
    assertTemporary();
    await link(temporaryPath, markerPath);
    await options.afterMarkerLink?.();
    assertDirectory();
    assertTemporary();
    assertRegularFileIdentity(markerPath, temporaryIdentity);
    markerCommitted = true;
    await cleanupTemporary();
    return "written";
  } catch (error) {
    if (handle !== undefined) {
      try { await handle.close(); } catch { /* cleanup still runs */ }
    }
    await cleanupTemporary();
    if (markerCommitted) return "written";
    return errorCode(error) === "EEXIST" ? "exists" : "failed";
  }
};

type MarkerWriteOptions = {
  readonly beforeTemporaryOpen?: () => void | Promise<void>;
  readonly afterTemporaryOpen?: () => void | Promise<void>;
  readonly beforeMarkerLink?: () => void | Promise<void>;
  readonly afterMarkerLink?: () => void | Promise<void>;
};

const projectChains = new Map<string, Promise<unknown>>();

const serialized = async <T>(projectRoot: string, operation: () => Promise<T>): Promise<T> => {
  const previous = projectChains.get(projectRoot) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  projectChains.set(projectRoot, current);
  try {
    return await current;
  } finally {
    if (projectChains.get(projectRoot) === current) projectChains.delete(projectRoot);
  }
};

const SAFE_PROJECT_SUFFIX = /^[a-z0-9-]+$/;
const projectIdFrom = (suffix: string): AssetResult<ProjectId> => {
  if (!SAFE_PROJECT_SUFFIX.test(suffix) || suffix.length > 120) {
    return {
      ok: false,
      failure: projectFailure("internal", "The Project ID source returned an invalid suffix.", ["projectId"], "invalid_project_id_suffix"),
    };
  }
  try {
    return { ok: true, value: createProjectMarkerDto(`project-${suffix}`).projectId };
  } catch {
    return {
      ok: false,
      failure: projectFailure("internal", "The Project ID source returned an invalid ID.", ["projectId"], "invalid_project_id"),
    };
  }
};

const inspectWorkspace = async (workspacePath: string, statPath: StatPath): Promise<AssetResult<string>> => {
  if (!isAbsolute(workspacePath) || workspacePath.trim() === "") {
    return {
      ok: false,
      failure: projectFailure("invalid_request", "The workspace path must be absolute.", ["workspacePath"], "invalid_workspace_path"),
    };
  }
  const normalized = resolve(workspacePath);
  try {
    const info = await statPath(normalized);
    return info.isDirectory()
      ? { ok: true, value: normalized }
      : { ok: false, failure: projectFailure("invalid_request", "The workspace path is not a directory.", ["workspacePath"], "invalid_workspace_path") };
  } catch (error) {
    const code = errorCode(error);
    return code === "ENOENT" || code === "ENOTDIR"
      ? {
          ok: false,
          failure: projectFailure("invalid_request", "The workspace path could not be opened as a directory.", ["workspacePath"], "invalid_workspace_path"),
        }
      : {
          ok: false,
          failure: projectFailure("unavailable", "The workspace could not be inspected.", ["workspacePath"], "unavailable"),
        };
  }
};

export const createProjectService = (options: ProjectServiceOptions): ProjectService => {
  const newProjectSuffix = options.newProjectSuffix ?? randomUUID;
  const statPath = options.statPath ?? stat;
  const unlinkPath = options.unlinkPath ?? unlink;

  const bind = async (
    workspacePath: string,
    projectRoot: string,
    projectId: ProjectId,
    source: MarkerSource,
  ): Promise<AssetResult<ProjectDiscoveryDto>> => {
    // The binding key is the discovered Project root, not whichever nested folder happened
    // to initiate discovery. Otherwise opening `packages/a` and later explicitly initializing
    // it as a nested Project would collide with the parent Project's cached binding.
    try {
      source.assertSource();
      const observed = await options.registry.observe(projectRoot, projectRoot, projectId, source.assertSource);
      if (!observed.ok) return observed;
      source.assertSource();
      return observed.value.status === "bound"
        ? { ok: true, value: { status: "initialized", workspacePath, projectRoot, projectId } }
        : {
            ok: true,
            value: {
              status: "mismatch",
              workspacePath,
              projectRoot,
              markerProjectId: projectId,
              registryProjectId: observed.value.registryProjectId,
            },
          };
    } catch (error) {
      return {
        ok: true,
        value: invalidDiscovery(workspacePath, projectRoot, sourceFailure(error, "The Project Marker source changed during discovery.")),
      };
    }
  };

  const discover = async (workspacePath: string): Promise<AssetResult<ProjectDiscoveryDto>> => {
    const inspected = await inspectWorkspace(workspacePath, statPath);
    if (!inspected.ok) return inspected;
    const normalizedWorkspace = inspected.value;
    let current = normalizedWorkspace;
    while (true) {
      const projectDirectory = join(current, PROJECT_DIRECTORY_NAME);
      try {
        const marker = await readMarker(
          projectDirectory,
          options.beforeMarkerDirectoryFreshStat,
          options.afterMarkerDirectoryFreshStat,
        );
        if (marker.status === "missing_directory") {
          const parent = dirname(current);
          if (parent === current) return { ok: true, value: { status: "uninitialized", workspacePath: normalizedWorkspace } };
          current = parent;
          continue;
        }
        if (marker.status === "missing_marker") {
          const failure = projectFailure("invalid_request", "The nearest .aacl directory has no Project Marker.", ["projectMarker"], "missing_marker");
          return { ok: true, value: invalidDiscovery(normalizedWorkspace, current, failure) };
        }
        if (marker.status === "invalid") {
          return { ok: true, value: invalidDiscovery(normalizedWorkspace, current, marker.failure) };
        }
        if (marker.status === "valid") return bind(normalizedWorkspace, current, marker.marker.projectId, marker.source);
        const failure = projectFailure("unavailable", "The workspace could not be searched for a Project Marker.", ["workspacePath"], "unavailable");
        return { ok: true, value: invalidDiscovery(normalizedWorkspace, current, failure) };
      } catch (error) {
        const failure = projectFailure("unavailable", "The workspace could not be searched for a Project Marker.", ["workspacePath"], "unavailable");
        return { ok: true, value: invalidDiscovery(normalizedWorkspace, current, failure) };
      }
    }
  };

  return {
    discover,
    initialize: async (projectRoot) => {
      const inspected = await inspectWorkspace(projectRoot, statPath);
      if (!inspected.ok) return inspected;
      const normalizedRoot = inspected.value;
      return serialized(normalizedRoot, async () => {
        const projectDirectory = join(normalizedRoot, PROJECT_DIRECTORY_NAME);
        const existingMarker = await readMarker(
          projectDirectory,
          options.beforeMarkerDirectoryFreshStat,
          options.afterMarkerDirectoryFreshStat,
        );
        if (existingMarker.status === "invalid") return { ok: false, failure: existingMarker.failure };
        if (existingMarker.status === "valid") {
          try {
            existingMarker.source.assertSource();
            const observed = await options.registry.observe(
              normalizedRoot,
              normalizedRoot,
              existingMarker.marker.projectId,
              existingMarker.source.assertSource,
            );
            if (!observed.ok) return observed;
            existingMarker.source.assertSource();
            return observed.value.status === "bound"
              ? { ok: true, value: { projectId: existingMarker.marker.projectId, projectRoot: normalizedRoot } }
              : {
                  ok: false,
                  failure: projectFailure("conflict", "The Project Marker conflicts with the registered Project identity.", ["projectMarker", "projectId"], "project_id_mismatch"),
                };
          } catch (error) {
            return { ok: false, failure: sourceFailure(error, "The Project Marker source changed during initialization.") };
          }
        }

        const proposed = projectIdFrom(newProjectSuffix());
        if (!proposed.ok) return proposed;
        const pending = await options.registry.prepare(normalizedRoot, normalizedRoot, proposed.value);
        if (!pending.ok) return pending;
        const marker = createProjectMarkerDto(pending.value);
        const prepared = await prepareProjectDirectory(normalizedRoot);
        if (!prepared.ok) return prepared;
        const markerPath = join(projectDirectory, PROJECT_MARKER_FILE_NAME);
        const write = await writeMarkerExclusively(markerPath, marker, unlinkPath, prepared.value.identity, {
          ...(options.beforeMarkerTemporaryOpen === undefined ? {} : { beforeTemporaryOpen: options.beforeMarkerTemporaryOpen }),
          ...(options.afterMarkerTemporaryOpen === undefined ? {} : { afterTemporaryOpen: options.afterMarkerTemporaryOpen }),
          ...(options.beforeMarkerLink === undefined ? {} : { beforeMarkerLink: options.beforeMarkerLink }),
          ...(options.afterMarkerLink === undefined ? {} : { afterMarkerLink: options.afterMarkerLink }),
        });
        if (write === "failed") {
          await removeEmptyProjectDirectory(prepared.value.path, prepared.value.created, prepared.value.identity);
          return {
            ok: false,
            failure: projectFailure("unavailable", "The Project Marker could not be created atomically.", ["projectMarker"], "unavailable"),
          };
        }
        if (options.afterMarkerWritten !== undefined && write === "written") await options.afterMarkerWritten();
        const installed = await readMarker(
          projectDirectory,
          options.beforeMarkerDirectoryFreshStat,
          options.afterMarkerDirectoryFreshStat,
        );
        if (installed.status === "invalid") return { ok: false, failure: installed.failure };
        if (installed.status !== "valid") {
          return {
            ok: false,
            failure: projectFailure("conflict", "The Project Marker disappeared during initialization.", ["projectMarker"], "marker_race"),
          };
        }
        try {
          if (!sameFileIdentity(installed.source.directoryIdentity, prepared.value.identity)) {
            throw new FileIdentityError("directory", projectDirectory);
          }
          installed.source.assertSource();
          const observed = await options.registry.observe(
            normalizedRoot,
            normalizedRoot,
            installed.marker.projectId,
            installed.source.assertSource,
          );
          if (!observed.ok) return observed;
          installed.source.assertSource();
          if (observed.value.status === "mismatch") {
            return {
              ok: false,
              failure: projectFailure("conflict", "The Project Marker conflicts with the registered Project identity.", ["projectMarker", "projectId"], "project_id_mismatch"),
            };
          }
          return { ok: true, value: { projectId: installed.marker.projectId, projectRoot: normalizedRoot } };
        } catch (error) {
          return {
            ok: false,
            failure: sourceFailure(error, "The Project Marker source changed during initialization."),
          };
        }
      });
    },
  };
};
