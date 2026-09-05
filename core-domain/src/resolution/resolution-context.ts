import type {
  DirectoryPath,
  ExecutionMode,
  ModelId,
  ProjectId,
  ProviderId,
  RoleId,
  RuntimeId,
  SkillId,
  StageId,
  TaskTypeId,
  WorkflowId,
  AssetRevision,
  ResolutionContextDto,
  ResolutionContextInput,
  WorkflowSelection,
} from "@aacl/shared";
import { EXECUTION_MODES } from "@aacl/shared";
import { coreFailure, type AssetResult } from "../failures.ts";

/**
 * The explicit execution state the caller resolved against, kept verbatim
 * alongside the normalized scope.
 *
 * `executionMode`, `workflow.kind` and a standalone `skillId` are not matching
 * axes, so the projection below drops them. They are still the state a resolved
 * context was produced for, which is what reconstructing one (#13) and the wire
 * `ResolvedContextDto.context` both need, so the resolver carries them through
 * rather than making its caller re-derive them.
 */
export type ValidatedExecutionContext = ResolutionContextDto;

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

/**
 * Which axes the context union carries as a top-level key. `workflowId` and
 * `stageId` are matching axes but not input keys — the union carries them
 * inside `workflow: { kind: "selected" }`, so accepting them at the top level
 * would resolve a request the published contract rejects.
 *
 * A `Record<ResolutionAxis, …>` rather than a second list: adding an axis then
 * fails to compile until this file says which side of the boundary it is on.
 */
const AXIS_IS_CONTEXT_KEY: Record<ResolutionAxis, boolean> = {
  projectId: true,
  workflowId: false,
  stageId: false,
  taskTypeId: true,
  roleId: true,
  providerId: true,
  runtimeId: true,
  modelId: true,
  directory: true,
};

const isContextAxis = (key: string): key is ResolutionAxis => isAxis(key) && AXIS_IS_CONTEXT_KEY[key];

/**
 * The fields each workflow-selection arm owns, keyed so that a new arm in the
 * published union fails to compile here until this file handles it.
 */
const WORKFLOW_SELECTION_FIELDS: Record<WorkflowSelection["kind"], readonly string[]> = {
  none: [],
  standalone: ["skillId"],
  selected: ["workflowId", "workflowRevision", "stageId"],
};

const isWorkflowKind = (value: unknown): value is WorkflowSelection["kind"] =>
  typeof value === "string" && Object.hasOwn(WORKFLOW_SELECTION_FIELDS, value);

const validateWorkflowSelection = (
  value: unknown,
  details: Detail[],
): WorkflowSelection | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    details.push(detail(["context", "workflow"], "invalid_value", "The workflow selection must be an object."));
    return undefined;
  }
  const selection = value as Record<string, unknown>;
  if (!isWorkflowKind(selection.kind)) {
    details.push(detail(["context", "workflow", "kind"], "invalid_value", "The workflow selection kind is unknown."));
    return undefined;
  }
  const kind = selection.kind;
  const fieldNames = WORKFLOW_SELECTION_FIELDS[kind];
  for (const key of Object.keys(selection)) {
    if (key === "kind" || fieldNames.includes(key)) continue;
    details.push(detail(["context", "workflow", key], "unknown_key", `Unknown workflow selection key "${key}".`));
  }
  const fields = new Map<string, string>();
  for (const key of fieldNames) {
    const fieldValue = selection[key];
    if (typeof fieldValue !== "string") {
      details.push(detail(["context", "workflow", key], "invalid_value", `Workflow selection key "${key}" must be a string.`));
      continue;
    }
    if (fieldValue.length === 0) {
      details.push(detail(["context", "workflow", key], "empty_identifier", `Workflow selection key "${key}" must not be empty.`));
      continue;
    }
    fields.set(key, fieldValue);
  }
  if (fields.size !== fieldNames.length) return undefined;
  switch (kind) {
    case "none": return { kind: "none" };
    case "standalone": return { kind: "standalone", skillId: fields.get("skillId")! as SkillId };
    case "selected": return {
      kind: "selected",
      workflowId: fields.get("workflowId")! as WorkflowId,
      workflowRevision: fields.get("workflowRevision")! as AssetRevision,
      stageId: fields.get("stageId")! as StageId,
    };
  }
};

const validateExecutionMode = (value: unknown, details: Detail[]): ExecutionMode | undefined => {
  if (typeof value !== "string" || !EXECUTION_MODES.includes(value as ExecutionMode)) {
    details.push(detail(["context", "executionMode"], "invalid_value", "The execution mode is unknown."));
    return undefined;
  }
  return value as ExecutionMode;
};

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

/**
 * Validate the published context union, then project the axes it matches on.
 *
 * The union is validated here rather than assumed: `resolveScope` takes an
 * unparsed input, so a caller that skipped `parseResolveRequest` would
 * otherwise resolve `development_execution` with `workflow: { kind: "none" }`,
 * a missing discriminant, or a non-string selected-workflow id against a
 * neutral scope — succeeding on exactly the states the contract rejects.
 */
export const toValidatedResolutionContext = (
  contextInput: ResolutionContextInput,
): AssetResult<{ readonly execution: ValidatedExecutionContext; readonly scope: ResolutionContext }> => {
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
  const executionAxes: {
    projectId?: ProjectId;
    taskTypeId?: TaskTypeId;
    roleId?: RoleId;
    providerId?: ProviderId;
    runtimeId?: RuntimeId;
    modelId?: ModelId;
    directory?: DirectoryPath;
  } = {};

  const executionMode = validateExecutionMode(input.executionMode, details);
  const workflowSelection = validateWorkflowSelection(input.workflow, details);
  if (executionMode === "development_execution" && workflowSelection?.kind === "none") {
    details.push(detail(
      ["context", "workflow", "kind"],
      "workflow_selection_required",
      "Development execution requires a standalone or selected workflow.",
    ));
  }
  if (workflowSelection?.kind === "selected") {
    context.workflowId = workflowSelection.workflowId;
    context.stageId = workflowSelection.stageId;
  }

  for (const key of Object.keys(input)) {
    if (key === "executionMode" || key === "workflow") continue;
    if (!isContextAxis(key)) {
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
      case "projectId": context.projectId = executionAxes.projectId = value as ProjectId; break;
      // `workflowId` / `stageId` reach the scope only through `workflow.kind: "selected"`.
      case "workflowId": case "stageId": break;
      case "taskTypeId": context.taskTypeId = executionAxes.taskTypeId = value as TaskTypeId; break;
      case "roleId": context.roleId = executionAxes.roleId = value as RoleId; break;
      case "providerId": context.providerId = executionAxes.providerId = value as ProviderId; break;
      case "runtimeId": context.runtimeId = executionAxes.runtimeId = value as RuntimeId; break;
      case "modelId": context.modelId = executionAxes.modelId = value as ModelId; break;
      case "directory": {
        const normalized = normalizeResolutionDirectory(value, ["context", key]);
        if (!normalized.ok) details.push(...(normalized.failure.details ?? []));
        else {
          context.directory = normalized.value.value;
          // The echoed context keeps what the caller sent; only the matching
          // scope holds the normalized form.
          executionAxes.directory = value as DirectoryPath;
        }
        break;
      }
    }
  }

  if (details.length > 0 || executionMode === undefined || workflowSelection === undefined) {
    // Both validators push a detail when they return undefined, so the second
    // list is unreachable; it is what narrows the two values below instead of
    // asserting them.
    return invalidScope(details.length > 0
      ? details
      : [detail(["context"], "invalid_value", "The resolution context is invalid.")]);
  }
  const axes = {
    ...(executionAxes.projectId === undefined ? {} : { projectId: executionAxes.projectId }),
    ...(executionAxes.taskTypeId === undefined ? {} : { taskTypeId: executionAxes.taskTypeId }),
    ...(executionAxes.roleId === undefined ? {} : { roleId: executionAxes.roleId }),
    ...(executionAxes.providerId === undefined ? {} : { providerId: executionAxes.providerId }),
    ...(executionAxes.runtimeId === undefined ? {} : { runtimeId: executionAxes.runtimeId }),
    ...(executionAxes.modelId === undefined ? {} : { modelId: executionAxes.modelId }),
    ...(executionAxes.directory === undefined ? {} : { directory: executionAxes.directory }),
  };
  if (executionMode === "development_execution") {
    if (workflowSelection.kind === "none") {
      return invalidScope([detail(
        ["context", "workflow", "kind"],
        "workflow_selection_required",
        "Development execution requires a standalone or selected workflow.",
      )]);
    }
    return {
      ok: true,
      value: { execution: { executionMode, workflow: workflowSelection, ...axes }, scope: context },
    };
  }
  return {
    ok: true,
    value: { execution: { executionMode, workflow: workflowSelection, ...axes }, scope: context },
  };
};

/** Normalize the nine resolution axes for the #3 resolver; execution state is not a matching axis. */
export const toResolutionContext = (contextInput: ResolutionContextInput): AssetResult<ResolutionContext> => {
  const validated = toValidatedResolutionContext(contextInput);
  return validated.ok ? { ok: true, value: validated.value.scope } : validated;
};
