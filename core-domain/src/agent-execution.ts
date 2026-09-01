import type {
  AgentExecutionDtoInput,
  AgentExecutionId,
  ExecutionInstanceId,
  ModelId,
  ProjectId,
  ProviderId,
  RoleId,
  RuntimeId,
  SessionId,
  SnapshotId,
  StageId,
  TaskTypeId,
  Timestamp,
  WorkflowId,
  WorkflowBindingInput,
} from "@aacl/shared";
import { tryParseAgentExecutionDto } from "@aacl/shared";
import { coreFailure, type AssetResult } from "./failures.ts";
import type { MetadataCatalog } from "./catalog.ts";
import type { ResolutionContext } from "./resolution-context.ts";

/** Internal execution metadata consumed by #8 routing and #20 lifecycle work. */
type AgentExecutionRecordBase = {
  readonly agentExecutionId: AgentExecutionId;
  readonly startedAt?: Timestamp;
  readonly endedAt?: Timestamp;
  readonly sessionId?: SessionId;
  readonly snapshotId?: SnapshotId;
  readonly projectId?: ProjectId;
  readonly stageId?: StageId;
  readonly taskTypeId?: TaskTypeId;
  readonly roleId?: RoleId;
  readonly providerId?: ProviderId;
  readonly runtimeId?: RuntimeId;
  readonly modelId?: ModelId;
};

export type AgentExecutionRecord =
  | (AgentExecutionRecordBase & {
      readonly workflowId: WorkflowId;
      readonly executionInstanceId: ExecutionInstanceId;
    })
  | (AgentExecutionRecordBase & {
      readonly workflowId?: never;
      readonly executionInstanceId?: never;
    });

type Detail = { readonly path: string[]; readonly code: string; readonly message: string };

const detail = (path: readonly string[], code: string, message: string): Detail => ({
  path: [...path],
  code,
  message,
});

/** Validate static execution references for the #8 routing policy and #20 lifecycle. */
export const validateAgentExecutionReferences = (
  catalog: MetadataCatalog,
  record: AgentExecutionRecord,
): AssetResult<undefined> => {
  const details: Detail[] = [];
  if (record.taskTypeId !== undefined && !catalog.taskTypes.has(record.taskTypeId)) {
    details.push(detail(["record", "taskTypeId"], "unknown_task_type_id", `Task type "${record.taskTypeId}" is not in the catalog.`));
  }
  if (record.roleId !== undefined && !catalog.roles.has(record.roleId)) {
    details.push(detail(["record", "roleId"], "unknown_role_id", `Role "${record.roleId}" is not in the catalog.`));
  }
  if (record.providerId !== undefined && !catalog.providers.has(record.providerId)) {
    details.push(detail(["record", "providerId"], "unknown_provider_id", `Provider "${record.providerId}" is not in the catalog.`));
  }
  if (record.runtimeId !== undefined && !catalog.runtimes.has(record.runtimeId)) {
    details.push(detail(["record", "runtimeId"], "unknown_runtime_id", `Runtime "${record.runtimeId}" is not in the catalog.`));
  }
  if (record.modelId !== undefined && !catalog.models.has(record.modelId)) {
    details.push(detail(["record", "modelId"], "unknown_model_id", `Model "${record.modelId}" is not in the catalog.`));
  }
  const runtime = record.runtimeId === undefined ? undefined : catalog.runtimes.get(record.runtimeId);
  if (
    record.providerId !== undefined &&
    runtime !== undefined &&
    runtime.providerId !== record.providerId
  ) {
    details.push(detail(
      ["record", "runtimeId"],
      "runtime_provider_mismatch",
      `Runtime "${record.runtimeId}" belongs to provider "${runtime.providerId}", not "${record.providerId}".`,
    ));
  }
  const model = record.modelId === undefined ? undefined : catalog.models.get(record.modelId);
  if (
    record.providerId !== undefined &&
    model !== undefined &&
    model.providerId !== record.providerId
  ) {
    details.push(detail(
      ["record", "modelId"],
      "model_provider_mismatch",
      `Model "${record.modelId}" belongs to provider "${model.providerId}", not "${record.providerId}".`,
    ));
  }
  // Relation membership belongs to #8 policy; execution may use a pair absent from the catalog relations.
  return details.length > 0
    ? { ok: false, failure: coreFailure("invalid_request", "The agent execution references are invalid.", details) }
    : { ok: true, value: undefined };
};

/**
 * Project an execution into the static scope consumed by #3.
 *
 * Execution instance identity is not a resolution axis, and cannot become one:
 * an asset declares its scope in frontmatter over `ASSET_SCOPE_AXES`, so it is
 * authored before any run exists, while an execution instance id is an opaque
 * value Core mints at start time. There is no value an asset author could write
 * to match one.
 */
export const agentExecutionScope = (record: AgentExecutionRecord): ResolutionContext => ({
  ...(record.projectId !== undefined ? { projectId: record.projectId } : {}),
  ...(record.workflowId !== undefined ? { workflowId: record.workflowId } : {}),
  ...(record.stageId !== undefined ? { stageId: record.stageId } : {}),
  ...(record.taskTypeId !== undefined ? { taskTypeId: record.taskTypeId } : {}),
  ...(record.roleId !== undefined ? { roleId: record.roleId } : {}),
  ...(record.providerId !== undefined ? { providerId: record.providerId } : {}),
  ...(record.runtimeId !== undefined ? { runtimeId: record.runtimeId } : {}),
  ...(record.modelId !== undefined ? { modelId: record.modelId } : {}),
});

const toWorkflowBindingInput = (
  record: AgentExecutionRecord,
): AssetResult<WorkflowBindingInput> => {
  // The record type makes a partial pair unrepresentable, but a cast or restored
  // data can still supply one, and no production caller exists yet to be trusted.
  // Read through a widened view rather than narrowing the union: handling both
  // complete cases first leaves `never` behind, and the remaining arms then cannot
  // read either field at all.
  const { workflowId, executionInstanceId } = record as AgentExecutionRecordBase & {
    readonly workflowId?: WorkflowId;
    readonly executionInstanceId?: ExecutionInstanceId;
  };
  if (workflowId === undefined && executionInstanceId === undefined) {
    return { ok: true, value: { kind: "standalone" } };
  }
  if (workflowId === undefined) {
    return {
      ok: false,
      failure: coreFailure(
        "invalid_request",
        "The agent execution workflow binding is incomplete.",
        [detail(
          ["record", "workflowId"],
          "missing_field",
          "A workflow-bound agent execution requires workflowId.",
        )],
      ),
    };
  }
  if (executionInstanceId === undefined) {
    return {
      ok: false,
      failure: coreFailure(
        "invalid_request",
        "The agent execution workflow binding is incomplete.",
        [detail(
          ["record", "executionInstanceId"],
          "missing_field",
          "A workflow-bound agent execution requires executionInstanceId.",
        )],
      ),
    };
  }
  return { ok: true, value: { kind: "workflow", workflowId, executionInstanceId } };
};

/** Project an execution into the DTO input consumed by #12 and #20. */
export const toAgentExecutionDto = (
  record: AgentExecutionRecord,
): AssetResult<AgentExecutionDtoInput> => {
  if (record.startedAt === undefined) {
    return {
      ok: false,
      failure: coreFailure("invalid_request", "The agent execution is missing startedAt.", [
        detail(["record", "startedAt"], "missing_field", "The agent execution is missing startedAt."),
      ]),
    };
  }
  const binding = toWorkflowBindingInput(record);
  if (!binding.ok) return binding;

  const value: AgentExecutionDtoInput = {
    agentExecutionId: record.agentExecutionId,
    startedAt: record.startedAt,
    workflowBinding: binding.value,
    ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
    ...(record.snapshotId !== undefined ? { snapshotId: record.snapshotId } : {}),
    ...(record.projectId !== undefined ? { projectId: record.projectId } : {}),
    ...(record.stageId !== undefined ? { stageId: record.stageId } : {}),
    ...(record.taskTypeId !== undefined ? { taskTypeId: record.taskTypeId } : {}),
    ...(record.roleId !== undefined ? { roleId: record.roleId } : {}),
    ...(record.providerId !== undefined ? { providerId: record.providerId } : {}),
    ...(record.runtimeId !== undefined ? { runtimeId: record.runtimeId } : {}),
    ...(record.modelId !== undefined ? { modelId: record.modelId } : {}),
    ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
  };
  const parsed = tryParseAgentExecutionDto(value);
  if (!parsed.ok) {
    return {
      ok: false,
      failure: coreFailure(
        "invalid_request",
        "The agent execution cannot be projected to a valid DTO.",
        parsed.error.details,
      ),
    };
  }
  return {
    ok: true,
    value: parsed.value,
  };
};
