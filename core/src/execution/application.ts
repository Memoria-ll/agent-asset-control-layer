import {
  authorizeExecutionOperation,
  initializeWorkflowState,
  toAgentExecutionDto,
  validateAgentExecutionReferences,
  type AssetResult,
  type AgentExecutionRecord,
  type MetadataCatalog,
  type WorkflowStartOrigin,
} from "@aacl/core-domain";
import {
  parseWorkflowStartCommitRequest,
  parseWorkflowStartResult,
  tryParseWorkflowStartRequest,
  type AgentExecutionId,
  type ResolutionContextDtoInput,
  type WorkflowStartCommitRequest,
  type WorkflowStartRequest,
  type WorkflowStartRequestInput,
  type WorkflowStartPreconditionContext,
} from "@aacl/shared";
import { coreFailure } from "@aacl/core-domain";
import type { WorkflowStateStore } from "../workflow/filesystem-state-store.ts";
import type { AssetStore } from "../assets/filesystem-store.ts";
import { loadWorkflowDefinitionAtRevision } from "../workflow/filesystem-definition-loader.ts";
import type { BoundedSkillCompletionVerifier, WorkflowStartCommitPort } from "./ports.ts";

export type WorkflowStartApplicationOptions = {
  readonly assetStore: AssetStore;
  readonly catalog: MetadataCatalog;
  readonly commitPort: WorkflowStartCommitPort;
  readonly boundedSkillCompletionVerifier: BoundedSkillCompletionVerifier;
  readonly stateStore: WorkflowStateStore;
  readonly now: () => string;
  readonly newAgentExecutionId: () => AgentExecutionId;
};

const failure = (message: string, code = "invalid_request"): AssetResult<never> => ({ ok: false, failure: coreFailure(code as "invalid_request" | "conflict", message) });

const PRECONDITION_AXES = ["projectId", "taskTypeId", "roleId", "providerId", "runtimeId", "modelId", "directory"] as const;

/** Compared field by field rather than by serialization, which would also compare key order. */
const samePreconditionContext = (
  left: WorkflowStartPreconditionContext,
  right: WorkflowStartPreconditionContext,
): boolean => {
  if (left.workflow.kind !== right.workflow.kind) return false;
  if (left.workflow.kind === "standalone" && right.workflow.kind === "standalone"
    && left.workflow.skillId !== right.workflow.skillId) return false;
  return PRECONDITION_AXES.every((axis) => left[axis] === right[axis]);
};

/** Build and submit one workflow-start bundle. Persistence is performed only by commitPort. */
export const startWorkflowExecution = async (
  input: WorkflowStartRequestInput | WorkflowStartRequest,
  options: WorkflowStartApplicationOptions,
): Promise<AssetResult<WorkflowStartCommitRequest>> => {
  const parsedRequest = tryParseWorkflowStartRequest(input);
  if (!parsedRequest.ok) return { ok: false, failure: coreFailure("invalid_request", parsedRequest.error.message, parsedRequest.error.details) };
  const request: WorkflowStartRequest = parsedRequest.value;
  let verifiedOrigin: WorkflowStartOrigin | undefined;
  if (request.startFrom.kind === "advisory_none") {
    verifiedOrigin = request.startFrom;
  } else if (
    request.context.executionMode === "advisory_preparation"
    && request.context.workflow.kind === "standalone"
    && request.context.workflow.skillId === request.startFrom.skillId
  ) {
    const verified = await options.boundedSkillCompletionVerifier.verify({
      agentExecutionId: request.startFrom.agentExecutionId,
      skillId: request.startFrom.skillId,
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    });
    if (!verified.ok) return verified;
    verifiedOrigin = { kind: "verified_bounded_skill_completion", skillId: request.startFrom.skillId };
  }
  const authorization = authorizeExecutionOperation(request.operation, request.context, verifiedOrigin);
  if (authorization.decision === "denied") {
    return { ok: false, failure: coreFailure("invalid_request", authorization.reason, [{ path: ["context"], code: authorization.reason, message: authorization.reason }]) };
  }

  const loaded = await loadWorkflowDefinitionAtRevision(options.assetStore, request.target.workflowId, request.target.workflowRevision, options.catalog);
  if (!loaded.ok) return loaded;
  // A workflow read from a project root applies to that project only: its on-disk location is
  // the applicability condition. Selection is by id and revision alone, so without this a
  // uniquely-named definition owned by one project starts under another one's context.
  if (loaded.source.kind === "project" && loaded.source.projectId !== request.context.projectId) {
    return { ok: false, failure: coreFailure("invalid_request", "The workflow definition belongs to another project.", [{
      path: ["target", "workflowId"],
      code: "workflow_project_mismatch",
      message: `Workflow "${request.target.workflowId}" is owned by project "${loaded.source.projectId}".`,
    }]) };
  }
  const issuedExecutionInstanceId = options.stateStore.issueExecutionInstanceId();
  if (!issuedExecutionInstanceId.ok) return issuedExecutionInstanceId;
  const executionInstanceId = issuedExecutionInstanceId.value;
  const agentExecutionId = options.newAgentExecutionId();
  const initialized = initializeWorkflowState(loaded.definition, {
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
  // The role the instance runs in is the state's, read from the state rather than echoed
  // from the request: the equality of the two holds only through the entry-stage role check
  // inside `initializeWorkflowState`, which is not visible here.
  const nextContext: ResolutionContextDtoInput = {
    ...request.context,
    executionMode: "development_execution",
    roleId: state.currentRoleId,
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
    roleId: state.currentRoleId,
    // The routing tuple travels with the execution, not only with the next context:
    // dropping it here is silent, because reference validation skips an absent axis
    // and the committed DTO keeps parsing without one.
    ...(request.context.providerId === undefined ? {} : { providerId: request.context.providerId }),
    ...(request.context.runtimeId === undefined ? {} : { runtimeId: request.context.runtimeId }),
    ...(request.context.modelId === undefined ? {} : { modelId: request.context.modelId }),
  };
  const references = validateAgentExecutionReferences(options.catalog, record);
  if (!references.ok) return references;
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
  let receipt: WorkflowStartCommitRequest;
  try {
    receipt = parseWorkflowStartResult(committed.value);
  } catch {
    return { ok: false, failure: coreFailure("internal", "The workflow start commit receipt is invalid.") };
  }
  // A receipt is internally consistent without being this request's: an adapter that answers
  // from the wrong idempotency entry returns another start that parses. The identifiers the
  // adapter may legitimately replay — execution, instance — are excluded; what identifies the
  // request is not.
  const answersThisRequest = receipt.idempotencyKey === bundle.idempotencyKey
    && receipt.precondition.target.workflowId === bundle.precondition.target.workflowId
    && receipt.precondition.target.workflowRevision === bundle.precondition.target.workflowRevision
    && samePreconditionContext(receipt.precondition.context, bundle.precondition.context);
  if (!answersThisRequest) {
    return { ok: false, failure: coreFailure("internal", "The workflow start commit receipt answers a different request.", [{
      path: ["receipt", "idempotencyKey"],
      code: "commit_receipt_mismatch",
      message: "The workflow start commit receipt answers a different request.",
    }]) };
  }
  return { ok: true, value: receipt };
};
