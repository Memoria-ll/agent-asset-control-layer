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
  ResolutionScopeInput,
} from "@aacl/shared";
import { coreFailure, type AssetResult } from "./failures.ts";

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

const detail = (path: readonly string[], code: string, message: string): Detail => ({
  path: [...path],
  code,
  message,
});

const invalidScope = (details: readonly Detail[]): AssetResult<never> => ({
  ok: false,
  failure: coreFailure("invalid_request", "The resolution scope is invalid.", details),
});

const AXES = [
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

const isAxis = (key: string): key is (typeof AXES)[number] => AXES.includes(key as (typeof AXES)[number]);

/** Normalize the nine resolution axes for the #3 resolver; execution IDs are rejected. */
export const toResolutionContext = (scope: ResolutionScopeInput): AssetResult<ResolutionContext> => {
  const raw = scope as unknown;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return invalidScope([detail(["scope"], "invalid_value", "The resolution scope must be an object.")]);
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

  for (const key of Object.keys(input)) {
    if (!isAxis(key)) {
      details.push(detail(["scope", key], "unknown_key", `Unknown resolution scope key "${key}".`));
      continue;
    }
    const value = input[key];
    if (typeof value !== "string") {
      details.push(detail(["scope", key], "invalid_value", `Resolution scope key "${key}" must be a string.`));
      continue;
    }
    if (value.length === 0) {
      details.push(detail(["scope", key], "empty_identifier", `Resolution scope key "${key}" must not be empty.`));
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
      case "directory": context.directory = value as DirectoryPath; break;
    }
  }

  return details.length > 0 ? invalidScope(details) : { ok: true, value: context };
};
