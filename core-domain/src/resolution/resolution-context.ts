import type {
  DirectoryPath,
  ModelId,
  ProjectId,
  ProviderId,
  RoleId,
  RuntimeId,
  StageId,
  TaskTypeId,
  WorkflowId,
  ResolutionContextInput,
} from "@aacl/shared";
import { coreFailure, type AssetResult } from "../failures.ts";

/** The normalized static scope consumed by the #3 resolver. */
export type ResolutionContext = {
  readonly projectId?: ProjectId;
  readonly workflowId?: WorkflowId;
  readonly stageId?: StageId;
  readonly taskTypeId?: TaskTypeId;
  readonly roleId?: RoleId;
  readonly providerId?: ProviderId;
  readonly runtimeId?: RuntimeId;
  readonly modelId?: ModelId;
  readonly directory?: DirectoryPath;
};

type Detail = { readonly path: string[]; readonly code: string; readonly message: string };

export const RESOLUTION_AXES = [
  "projectId",
  "workflowId",
  "stageId",
  "taskTypeId",
  "roleId",
  "providerId",
  "runtimeId",
  "modelId",
  "directory",
] as const;

export type ResolutionAxis = (typeof RESOLUTION_AXES)[number];

const detail = (path: readonly string[], code: string, message: string): Detail => ({
  path: [...path],
  code,
  message,
});

const invalidScope = (details: readonly Detail[]): AssetResult<never> => ({
  ok: false,
  failure: coreFailure("invalid_request", "The resolution scope is invalid.", details),
});

const isAxis = (key: string): key is ResolutionAxis => RESOLUTION_AXES.includes(key as ResolutionAxis);

export type NormalizedDirectory = {
  readonly value: DirectoryPath;
  readonly segments: readonly string[];
};

/**
 * Accept only the normalized POSIX absolute form; reject anything else rather than
 * converting it.
 *
 * The split is lexical rather than `node:path`'s: this package may not reach for host
 * capabilities, and a host resolver would also answer differently on Windows than under
 * WSL for the same string. Backslash paths, drive letters and relative paths are rejected
 * instead of rewritten because mapping a Windows path onto its WSL mount is not a lexical
 * transformation, and guessing one would turn a wrong path into a silently non-matching
 * one. That conversion belongs to the IDE context boundary (#36).
 */
export const normalizeResolutionDirectory = (
  value: unknown,
  detailPath: readonly string[],
): AssetResult<NormalizedDirectory> => {
  if (typeof value !== "string") {
    return {
      ok: false,
      failure: coreFailure("invalid_request", "The directory must be a string.", [
        detail(detailPath, "invalid_value", "The directory must be a string."),
      ]),
    };
  }
  if (value.length === 0) {
    return {
      ok: false,
      failure: coreFailure("invalid_request", "The directory must not be empty.", [
        detail(detailPath, "empty_identifier", "The directory must not be empty."),
      ]),
    };
  }
  if (value.includes("\\") || !value.startsWith("/")) {
    return {
      ok: false,
      failure: coreFailure("invalid_request", "The directory must be a POSIX absolute path.", [
        detail(detailPath, "invalid_directory", "The directory must be a POSIX absolute path."),
      ]),
    };
  }

  const trimmed = value.replace(/\/+$/, "") || "/";
  if (trimmed === "/") return { ok: true, value: { value: trimmed as DirectoryPath, segments: [] } };

  const segments = trimmed.slice(1).split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return {
      ok: false,
      failure: coreFailure("invalid_request", "The directory contains an invalid segment.", [
        detail(detailPath, "invalid_directory", "The directory contains an invalid segment."),
      ]),
    };
  }
  return { ok: true, value: { value: trimmed as DirectoryPath, segments } };
};

/** Normalize the nine resolution axes for the #3 resolver; execution state is not a matching axis. */
export const toResolutionContext = (contextInput: ResolutionContextInput): AssetResult<ResolutionContext> => {
  const raw = contextInput as unknown;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return invalidScope([detail(["context"], "invalid_value", "The resolution context must be an object.")]);
  }

  const input = raw as Record<string, unknown>;
  const details: Detail[] = [];
  const context: {
    projectId?: ProjectId;
    workflowId?: WorkflowId;
    stageId?: StageId;
    taskTypeId?: TaskTypeId;
    roleId?: RoleId;
    providerId?: ProviderId;
    runtimeId?: RuntimeId;
    modelId?: ModelId;
    directory?: DirectoryPath;
  } = {};

  const workflow = input.workflow;
  if (workflow !== null && typeof workflow === "object" && !Array.isArray(workflow)) {
    const selectedWorkflow = workflow as Record<string, unknown>;
    if (selectedWorkflow.kind === "selected") {
      context.workflowId = selectedWorkflow.workflowId as WorkflowId;
      context.stageId = selectedWorkflow.stageId as StageId;
    }
  }

  for (const key of Object.keys(input)) {
    if (key === "executionMode" || key === "workflow") continue;
    if (!isAxis(key)) {
      details.push(detail(["context", key], "unknown_key", `Unknown resolution context key "${key}".`));
      continue;
    }
    const value = input[key];
    if (typeof value !== "string") {
      details.push(detail(["context", key], "invalid_value", `Resolution context key "${key}" must be a string.`));
      continue;
    }
    if (value.length === 0) {
      details.push(detail(["context", key], "empty_identifier", `Resolution context key "${key}" must not be empty.`));
      continue;
    }
    switch (key) {
      case "projectId": context.projectId = value as ProjectId; break;
      case "workflowId": context.workflowId = value as WorkflowId; break;
      case "stageId": context.stageId = value as StageId; break;
      case "taskTypeId": context.taskTypeId = value as TaskTypeId; break;
      case "roleId": context.roleId = value as RoleId; break;
      case "providerId": context.providerId = value as ProviderId; break;
      case "runtimeId": context.runtimeId = value as RuntimeId; break;
      case "modelId": context.modelId = value as ModelId; break;
      case "directory": {
        const normalized = normalizeResolutionDirectory(value, ["context", key]);
        if (!normalized.ok) details.push(...(normalized.failure.details ?? []));
        else context.directory = normalized.value.value;
        break;
      }
    }
  }

  return details.length > 0 ? invalidScope(details) : { ok: true, value: context };
};
