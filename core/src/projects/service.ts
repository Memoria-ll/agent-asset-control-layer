import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, rmdir, stat, unlink } from "node:fs/promises";
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
import { readRegularUtf8 } from "../internal/regular-file.ts";

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
};

type MarkerRead =
  | { readonly status: "missing" }
  | { readonly status: "valid"; readonly marker: ProjectMarkerDto }
  | { readonly status: "invalid"; readonly failure: CoreFailure };

const projectFailure = (
  code: "invalid_request" | "conflict" | "unavailable" | "internal",
  message: string,
  path: readonly string[],
  detailCode: string,
): CoreFailure => coreFailure(code, message, [{ path: [...path], code: detailCode, message }]);

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
};

const invalidDiscovery = (
  workspacePath: string,
  projectRoot: string,
  failure: CoreFailure,
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

const readMarker = async (markerPath: string): Promise<MarkerRead> => {
  let info;
  try {
    info = await lstat(markerPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { status: "missing" };
    return {
      status: "invalid",
      failure: projectFailure("unavailable", "The Project Marker could not be inspected.", ["projectMarker"], "unavailable"),
    };
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    return {
      status: "invalid",
      failure: projectFailure("invalid_request", "The Project Marker is not a regular file.", ["projectMarker"], "invalid_marker_file"),
    };
  }

  const read = await readRegularUtf8(markerPath);
  if (read.status === "missing") return { status: "missing" };
  if (read.status === "not_regular") {
    return {
      status: "invalid",
      failure: projectFailure("invalid_request", "The Project Marker is not a regular file.", ["projectMarker"], "invalid_marker_file"),
    };
  }
  if (read.status === "unavailable") {
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
    return { status: "valid", marker: parsed.value };
  } catch {
    return {
      status: "invalid",
      failure: projectFailure("invalid_request", "The Project Marker is not valid JSON.", ["projectMarker"], "invalid_json"),
    };
  }
};

const prepareProjectDirectory = async (
  projectRoot: string,
): Promise<AssetResult<{ readonly path: string; readonly created: boolean }>> => {
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
    if (info !== undefined) return { ok: true, value: { path: projectDirectory, created: false } };
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
    return { ok: true, value: { path: projectDirectory, created } };
  } catch {
    return {
      ok: false,
      failure: projectFailure("unavailable", "The .aacl directory could not be prepared.", ["projectRoot"], "unavailable"),
    };
  }
};

const removeEmptyProjectDirectory = async (projectDirectory: string, created: boolean): Promise<void> => {
  if (!created) return;
  try {
    await rmdir(projectDirectory);
  } catch {
    // A concurrent initializer or a user-written asset keeps the directory in place.
  }
};

const writeMarkerExclusively = async (
  markerPath: string,
  marker: ProjectMarkerDto,
): Promise<"written" | "exists" | "failed"> => {
  const temporaryPath = join(dirname(markerPath), `.aacl.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o644);
    await handle.writeFile(`${JSON.stringify(marker, null, 2)}\n`, "utf8");
    await handle.close();
    handle = undefined;
    await link(temporaryPath, markerPath);
    await unlink(temporaryPath);
    return "written";
  } catch (error) {
    if (handle !== undefined) {
      try { await handle.close(); } catch { /* cleanup still runs */ }
    }
    try { await unlink(temporaryPath); } catch { /* the operation failure is primary */ }
    return errorCode(error) === "EEXIST" ? "exists" : "failed";
  }
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

const inspectWorkspace = async (workspacePath: string): Promise<AssetResult<string>> => {
  if (!isAbsolute(workspacePath) || workspacePath.trim() === "") {
    return {
      ok: false,
      failure: projectFailure("invalid_request", "The workspace path must be absolute.", ["workspacePath"], "invalid_workspace_path"),
    };
  }
  const normalized = resolve(workspacePath);
  try {
    const info = await stat(normalized);
    return info.isDirectory()
      ? { ok: true, value: normalized }
      : { ok: false, failure: projectFailure("invalid_request", "The workspace path is not a directory.", ["workspacePath"], "invalid_workspace_path") };
  } catch {
    return {
      ok: false,
      failure: projectFailure("invalid_request", "The workspace path could not be opened as a directory.", ["workspacePath"], "invalid_workspace_path"),
    };
  }
};

export const createProjectService = (options: ProjectServiceOptions): ProjectService => {
  const newProjectSuffix = options.newProjectSuffix ?? randomUUID;

  const bind = async (
    workspacePath: string,
    projectRoot: string,
    projectId: ProjectId,
  ): Promise<AssetResult<ProjectDiscoveryDto>> => {
    // The binding key is the discovered Project root, not whichever nested folder happened
    // to initiate discovery. Otherwise opening `packages/a` and later explicitly initializing
    // it as a nested Project would collide with the parent Project's cached binding.
    const observed = await options.registry.observe(projectRoot, projectRoot, projectId);
    if (!observed.ok) return observed;
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
  };

  const discover = async (workspacePath: string): Promise<AssetResult<ProjectDiscoveryDto>> => {
    const inspected = await inspectWorkspace(workspacePath);
    if (!inspected.ok) return inspected;
    const normalizedWorkspace = inspected.value;
    let current = normalizedWorkspace;
    while (true) {
      const projectDirectory = join(current, PROJECT_DIRECTORY_NAME);
      try {
        const info = await lstat(projectDirectory);
        if (info.isSymbolicLink() || !info.isDirectory()) {
          const failure = projectFailure("invalid_request", "The nearest .aacl path is not a regular directory.", ["projectMarker"], "invalid_project_directory");
          return { ok: true, value: invalidDiscovery(normalizedWorkspace, current, failure) };
        }
        const marker = await readMarker(join(projectDirectory, PROJECT_MARKER_FILE_NAME));
        if (marker.status === "missing") {
          const failure = projectFailure("invalid_request", "The nearest .aacl directory has no Project Marker.", ["projectMarker"], "missing_marker");
          return { ok: true, value: invalidDiscovery(normalizedWorkspace, current, failure) };
        }
        if (marker.status === "invalid") {
          return { ok: true, value: invalidDiscovery(normalizedWorkspace, current, marker.failure) };
        }
        return bind(normalizedWorkspace, current, marker.marker.projectId);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          const failure = projectFailure("unavailable", "The workspace could not be searched for a Project Marker.", ["workspacePath"], "unavailable");
          return { ok: true, value: invalidDiscovery(normalizedWorkspace, current, failure) };
        }
      }
      const parent = dirname(current);
      if (parent === current) return { ok: true, value: { status: "uninitialized", workspacePath: normalizedWorkspace } };
      current = parent;
    }
  };

  return {
    discover,
    initialize: async (projectRoot) => {
      const inspected = await inspectWorkspace(projectRoot);
      if (!inspected.ok) return inspected;
      const normalizedRoot = inspected.value;
      return serialized(normalizedRoot, async () => {
        const projectDirectory = join(normalizedRoot, PROJECT_DIRECTORY_NAME);
        let directoryInfo;
        try {
          directoryInfo = await lstat(projectDirectory);
        } catch (error) {
          if (errorCode(error) !== "ENOENT") {
            return {
              ok: false,
              failure: projectFailure("unavailable", "The .aacl path could not be inspected.", ["projectRoot"], "unavailable"),
            };
          }
        }
        if (directoryInfo !== undefined && (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory())) {
          return {
            ok: false,
            failure: projectFailure("invalid_request", "The .aacl path is not a regular directory.", ["projectRoot"], "invalid_project_directory"),
          };
        }

        const markerPath = join(projectDirectory, PROJECT_MARKER_FILE_NAME);
        const existingMarker = await readMarker(markerPath);
        if (existingMarker.status === "invalid") return { ok: false, failure: existingMarker.failure };
        if (existingMarker.status === "valid") {
          const observed = await options.registry.observe(normalizedRoot, normalizedRoot, existingMarker.marker.projectId);
          if (!observed.ok) return observed;
          return observed.value.status === "bound"
            ? { ok: true, value: { projectId: existingMarker.marker.projectId, projectRoot: normalizedRoot } }
            : {
                ok: false,
                failure: projectFailure("conflict", "The Project Marker conflicts with the registered Project identity.", ["projectMarker", "projectId"], "project_id_mismatch"),
              };
        }

        const proposed = projectIdFrom(newProjectSuffix());
        if (!proposed.ok) return proposed;
        const pending = await options.registry.prepare(normalizedRoot, normalizedRoot, proposed.value);
        if (!pending.ok) return pending;
        const marker = createProjectMarkerDto(pending.value);
        const prepared = await prepareProjectDirectory(normalizedRoot);
        if (!prepared.ok) return prepared;
        const write = await writeMarkerExclusively(markerPath, marker);
        if (write === "failed") {
          await removeEmptyProjectDirectory(prepared.value.path, prepared.value.created);
          return {
            ok: false,
            failure: projectFailure("unavailable", "The Project Marker could not be created atomically.", ["projectMarker"], "unavailable"),
          };
        }
        const installed = write === "written" ? marker : await readMarker(markerPath);
        if (options.afterMarkerWritten !== undefined && write === "written") await options.afterMarkerWritten();
        if (!("projectId" in installed) && installed.status !== "valid") {
          const failure = installed.status === "invalid"
            ? installed.failure
            : projectFailure("conflict", "The Project Marker disappeared during initialization.", ["projectMarker"], "marker_race");
          return { ok: false, failure };
        }
        const installedProjectId = "projectId" in installed ? installed.projectId : installed.marker.projectId;
        const observed = await options.registry.observe(normalizedRoot, normalizedRoot, installedProjectId);
        if (!observed.ok) return observed;
        if (observed.value.status === "mismatch") {
          return {
            ok: false,
            failure: projectFailure("conflict", "The Project Marker conflicts with the registered Project identity.", ["projectMarker", "projectId"], "project_id_mismatch"),
          };
        }
        return { ok: true, value: { projectId: installedProjectId, projectRoot: normalizedRoot } };
      });
    },
  };
};
