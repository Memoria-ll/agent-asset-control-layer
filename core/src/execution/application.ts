import {
  authorizeExecutionOperation,
  initializeWorkflowState,
  toAgentExecutionDto,
  type AssetResult,
  type AgentExecutionRecord,
  type MetadataCatalog,
} from "@aacl/core-domain";
import {
  parseWorkflowStartCommitRequest,
  tryParseWorkflowStartRequest,
  type AgentExecutionId,
  type ResolutionContextDtoInput,
  type WorkflowStartCommitRequest,
  type WorkflowStartRequest,
  type WorkflowStartRequestInput,
} from "@aacl/shared";
import { coreFailure } from "@aacl/core-domain";
import type { WorkflowStateStore } from "../workflow/filesystem-state-store.ts";
import type { AssetStore } from "../assets/filesystem-store.ts";
import { loadWorkflowDefinitionAtRevision } from "../workflow/filesystem-definition-loader.ts";
import type { WorkflowStartCommitPort } from "./ports.ts";

export type WorkflowStartApplicationOptions = {
  readonly assetStore: AssetStore;
  readonly catalog: MetadataCatalog;
  readonly commitPort: WorkflowStartCommitPort;
  readonly stateStore: WorkflowStateStore;
  readonly now: () => string;
  readonly newAgentExecutionId: () => AgentExecutionId;
};

const failure = (message: string, code = "invalid_request"): AssetResult<never> => ({ ok: false, failure: coreFailure(code as "invalid_request" | "conflict", message) });

/** Build and submit one workflow-start bundle. Persistence is performed only by commitPort. */
export const startWorkflowExecution = async (
  input: WorkflowStartRequestInput | WorkflowStartRequest,
  options: WorkflowStartApplicationOptions,
): Promise<AssetResult<WorkflowStartCommitRequest>> => {
  const parsedRequest = tryParseWorkflowStartRequest(input);
  if (!parsedRequest.ok) return { ok: false, failure: coreFailure("invalid_request", parsedRequest.error.message, parsedRequest.error.details) };
  const request: WorkflowStartRequest = parsedRequest.value;
  const authorization = authorizeExecutionOperation(request.operation, request.context, request.startFrom);
  if (authorization.decision === "denied") {
    return { ok: false, failure: coreFailure("invalid_request", authorization.reason, [{ path: ["context"], code: authorization.reason, message: authorization.reason }]) };
  }

  const loaded = await loadWorkflowDefinitionAtRevision(options.assetStore, request.target.workflowId, request.target.workflowRevision, options.catalog);
  if (!loaded.ok) return loaded;
  const executionInstanceId = options.stateStore.issueExecutionInstanceId();
  const agentExecutionId = options.newAgentExecutionId();
  const initialized = initializeWorkflowState(loaded.definition, {
    workflowRevision: loaded.revision,
    linkedAgentExecutionIds: [agentExecutionId],
    linkedSnapshotIds: [],
  }, {
    ...(request.context.roleId === undefined ? {} : { roleId: request.context.roleId }),
    ...(request.context.taskTypeId === undefined ? {} : { taskTypeId: request.context.taskTypeId }),
    availableCapabilityRefs: request.availableCapabilityRefs,
    availableArtifactRefs: request.availableArtifactRefs,
  });
  if (!initialized.ok) return initialized;
  const state = {
    ...initialized.value,
    executionInstanceId,
    stateVersion: 0 as const,
    updatedAt: options.now(),
  };
  const nextContext: ResolutionContextDtoInput = {
    ...request.context,
    executionMode: "development_execution",
    workflow: {
      kind: "selected",
      workflowId: loaded.definition.workflowId,
      workflowRevision: loaded.revision,
      stageId: loaded.definition.entryStageId,
    },
  };
  const record: AgentExecutionRecord = {
    agentExecutionId,
    executionMode: "development_execution",
    startedAt: state.updatedAt,
    workflowId: loaded.definition.workflowId,
    workflowRevision: loaded.revision,
    executionInstanceId,
    ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    ...(request.context.projectId === undefined ? {} : { projectId: request.context.projectId }),
    stageId: loaded.definition.entryStageId,
    ...(request.context.taskTypeId === undefined ? {} : { taskTypeId: request.context.taskTypeId }),
    ...(request.context.roleId === undefined ? {} : { roleId: request.context.roleId }),
  };
  const agent = toAgentExecutionDto(record);
  if (!agent.ok) return agent;
  const bundleInput = {
    operation: "workflow_start" as const,
    idempotencyKey: request.idempotencyKey,
    precondition: { context: request.context, target: request.target },
    nextContext,
    agentExecution: agent.value,
    workflowState: state,
    ...(request.sessionId === undefined ? {} : { sessionUpdate: { sessionId: request.sessionId, addAgentExecutionId: agentExecutionId } }),
  };
  let bundle: WorkflowStartCommitRequest;
  try {
    bundle = parseWorkflowStartCommitRequest(bundleInput);
  } catch {
    return failure("The workflow start bundle is invalid.");
  }
  const committed = await options.commitPort.commit(bundle);
  if (!committed.ok) return committed;
  try {
    return { ok: true, value: parseWorkflowStartCommitRequest(committed.value) };
  } catch {
    return { ok: false, failure: coreFailure("internal", "The workflow start commit receipt is invalid.") };
  }
};
