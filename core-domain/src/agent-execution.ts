import type {
  AgentExecutionDtoInput,
  AgentExecutionId,
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
} from "@aacl/shared";
import { coreFailure, type AssetResult } from "./failures.ts";
import type { MetadataCatalog } from "./catalog.ts";
import type { ResolutionContext } from "./resolution-context.ts";

/** Internal execution metadata consumed by #8 routing and #20 lifecycle work. */
export type AgentExecutionRecord = {
  readonly agentExecutionId: AgentExecutionId;
  readonly startedAt?: Timestamp;
  readonly endedAt?: Timestamp;
  readonly sessionId?: SessionId;
  readonly snapshotId?: SnapshotId;
  readonly projectId?: ProjectId;
  readonly workflowId?: WorkflowId;
  readonly stageId?: StageId;
  readonly taskTypeId?: TaskTypeId;
  readonly roleId?: RoleId;
  readonly providerId?: ProviderId;
  readonly runtimeId?: RuntimeId;
  readonly modelId?: ModelId;
};

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
  // Relation membership belongs to #8 policy; execution may use a pair absent from the catalog relations.
  return details.length > 0
    ? { ok: false, failure: coreFailure("invalid_request", "The agent execution references are invalid.", details) }
    : { ok: true, value: undefined };
};

/** Project an execution into the static scope consumed by #3; the execution ID is not a scope axis. */
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
  return {
    ok: true,
    value: {
      agentExecutionId: record.agentExecutionId,
      startedAt: record.startedAt,
      ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
      ...(record.snapshotId !== undefined ? { snapshotId: record.snapshotId } : {}),
      ...(record.projectId !== undefined ? { projectId: record.projectId } : {}),
      ...(record.workflowId !== undefined ? { workflowId: record.workflowId } : {}),
      ...(record.stageId !== undefined ? { stageId: record.stageId } : {}),
      ...(record.taskTypeId !== undefined ? { taskTypeId: record.taskTypeId } : {}),
      ...(record.roleId !== undefined ? { roleId: record.roleId } : {}),
      ...(record.providerId !== undefined ? { providerId: record.providerId } : {}),
      ...(record.runtimeId !== undefined ? { runtimeId: record.runtimeId } : {}),
      ...(record.modelId !== undefined ? { modelId: record.modelId } : {}),
      ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
    },
  };
};
