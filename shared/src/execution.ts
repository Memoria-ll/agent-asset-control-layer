import * as z from "zod/mini";
import { AgentExecutionId, AssetRevision, SessionId, SkillId, WorkflowId } from "./identifiers.ts";
import { NonEmptyString } from "./primitives.ts";
import { ResolutionContextInput, SelectedWorkflowContext, WorkflowStartPreconditionContext } from "./resolved-context.ts";
import { AgentExecutionDto, WorkflowBoundBinding } from "./sessions.ts";
import { WorkflowStateDto } from "./workflow.ts";
import { tryParseWith, type ParseOutcome } from "./errors.ts";

export const EXECUTION_OPERATION_KINDS = [
  "ask_question", "research", "consideration", "issue_creation", "preparation_material",
  "bounded_skill", "workflow_start", "implementation", "repository_change", "pull_request",
] as const;
export const ExecutionOperationKind = z.enum(EXECUTION_OPERATION_KINDS);
export type ExecutionOperationKind = z.infer<typeof ExecutionOperationKind>;

const workflowTarget = z.strictObject({ workflowId: WorkflowId, workflowRevision: AssetRevision });
const advisoryNone = z.strictObject({ kind: z.literal("advisory_none") });
const boundedSkillExecution = z.strictObject({
  kind: z.literal("bounded_skill_execution"),
  skillId: SkillId,
  agentExecutionId: AgentExecutionId,
});
const startFrom = z.discriminatedUnion("kind", [advisoryNone, boundedSkillExecution]);

const authorizationStart = z.strictObject({ startFrom, target: workflowTarget });
const workflowStartAuthorizationRequest = z.strictObject({
  operation: z.literal("workflow_start"),
  context: ResolutionContextInput,
  workflowStart: authorizationStart,
});
const nonWorkflowStartOperations = EXECUTION_OPERATION_KINDS.filter((kind) => kind !== "workflow_start");
const ordinaryAuthorizationRequest = z.strictObject({
  operation: z.enum(nonWorkflowStartOperations),
  context: ResolutionContextInput,
});
export const ExecutionAuthorizationRequest = z.xor([
  workflowStartAuthorizationRequest,
  ordinaryAuthorizationRequest,
]);
export type ExecutionAuthorizationRequest = z.infer<typeof ExecutionAuthorizationRequest>;
export type ExecutionAuthorizationRequestInput = z.input<typeof ExecutionAuthorizationRequest>;

const denied = <Reason extends string, Operation extends z.core.$ZodType, Guidance extends z.core.$ZodType>(
  reason: Reason,
  operation: Operation,
  guidance: Guidance,
) => z.strictObject({
  decision: z.literal("denied"),
  operation,
  reason: z.literal(reason),
  guidance,
});
const developmentOperation = z.enum(["implementation", "repository_change", "pull_request"]);
const denialArms = [
  denied("workflow_selection_required", developmentOperation, z.strictObject({ kind: z.literal("select_workflow"), nextOperation: z.literal("workflow_start") })),
  denied("skill_selection_required", z.literal("bounded_skill"), z.strictObject({ kind: z.literal("select_bounded_skill"), nextOperation: z.literal("bounded_skill") })),
  denied("operation_not_allowed_in_mode", z.literal("bounded_skill"), z.strictObject({ kind: z.literal("use_advisory_mode"), requiredMode: z.literal("advisory_preparation") })),
  denied("development_mode_required", developmentOperation, z.strictObject({ kind: z.literal("use_development_mode"), requiredMode: z.literal("development_execution") })),
  denied("workflow_start_requires_advisory_context", z.literal("workflow_start"), z.strictObject({ kind: z.literal("use_advisory_mode"), requiredMode: z.literal("advisory_preparation") })),
  denied("workflow_start_requires_completed_skill", z.literal("workflow_start"), z.strictObject({ kind: z.literal("complete_bounded_skill"), nextOperation: z.literal("workflow_start") })),
  denied("workflow_already_selected", z.literal("workflow_start"), z.strictObject({ kind: z.literal("continue_selected_workflow"), nextOperation: z.literal("implementation") })),
] as const;
export const ExecutionAuthorizationResult = z.xor([
  z.strictObject({ decision: z.literal("allowed"), operation: ExecutionOperationKind }),
  ...denialArms,
]);
export type ExecutionAuthorizationResult = z.infer<typeof ExecutionAuthorizationResult>;

export const WorkflowStartRequest = z.strictObject({
  operation: z.literal("workflow_start"),
  idempotencyKey: NonEmptyString,
  context: ResolutionContextInput,
  startFrom,
  target: workflowTarget,
  sessionId: z.optional(SessionId),
  availableCapabilityRefs: z.array(NonEmptyString),
  availableArtifactRefs: z.array(NonEmptyString),
});
export type WorkflowStartRequest = z.infer<typeof WorkflowStartRequest>;
export type WorkflowStartRequestInput = z.input<typeof WorkflowStartRequest>;

/**
 * A workflow start mints the instance, so its state is the first snapshot and no
 * update has been applied to it yet. The version is pinned on the field rather
 * than inside the bundle refinement below because a cross-field check emits
 * nothing into the published JSON Schema, leaving a schema-driven consumer to
 * accept a start whose state has already advanced.
 */
const InitialWorkflowState = z.extend(WorkflowStateDto, { stateVersion: z.literal(0) });

/**
 * The resolution axes an execution record carries as well as the context. A start whose
 * record disagrees with its own next context on any of them cannot reproduce the context
 * it was resolved against, so the pair is checked as a whole rather than per axis: the
 * routing tuple and the scope axes fail the same way and are missed the same way.
 *
 * `directory` is absent because the execution record has no such field.
 */
const MIRRORED_CONTEXT_AXES = ["projectId", "taskTypeId", "roleId", "providerId", "runtimeId", "modelId"] as const;

/**
 * The axes a start carries over unchanged. Selecting a workflow does not move the caller to
 * another project, task, machine or directory. `roleId` is deliberately absent: it is the one
 * axis the start itself sets, from the state the definition initialized.
 */
const PRESERVED_CONTEXT_AXES = ["projectId", "taskTypeId", "providerId", "runtimeId", "modelId", "directory"] as const;

/**
 * The execution a start produces: bound to the workflow, in development mode, and neither
 * ended nor snapshotted. `endedAt` and `snapshotId` are removed rather than forbidden by a
 * check, so a schema-driven consumer sees the same contract the parser enforces.
 */
const StartedWorkflowExecution = z.omit(
  z.extend(AgentExecutionDto, {
    executionMode: z.literal("development_execution"),
    workflowBinding: WorkflowBoundBinding,
  }),
  { endedAt: true, snapshotId: true },
);

/**
 * What this contract is, and is not: it constrains the four documents in the bundle and checks
 * them against each other, and nothing else. The workflow definition is not part of the bundle,
 * so facts derived from it — stage requirements, catalog membership, whether a role exists —
 * cannot be decided here and belong to the application that loads the definition.
 *
 * Everything decidable from the bundle alone is stated below, and stated as a field type
 * wherever it fits in one, because a cross-field check emits nothing into the published JSON
 * Schema. What remains in the refinement is the part that relates two documents.
 */
export const WorkflowStartCommitRequest = z.strictObject({
  operation: z.literal("workflow_start"),
  idempotencyKey: NonEmptyString,
  precondition: z.strictObject({ context: WorkflowStartPreconditionContext, target: workflowTarget }),
  nextContext: SelectedWorkflowContext,
  agentExecution: StartedWorkflowExecution,
  workflowState: InitialWorkflowState,
  sessionUpdate: z.optional(z.strictObject({ sessionId: SessionId, addAgentExecutionId: AgentExecutionId })),
}).check(z.refine((value) => {
  const selected = value.nextContext.workflow;
  const binding = value.agentExecution.workflowBinding;
  const target = value.precondition.target;
  const state = value.workflowState;
  if (selected.workflowId !== target.workflowId || selected.workflowRevision !== target.workflowRevision) return false;
  if (binding.workflowId !== target.workflowId || binding.workflowRevision !== target.workflowRevision) return false;
  if (state.workflowId !== target.workflowId || state.workflowRevision !== target.workflowRevision) return false;
  if (binding.executionInstanceId !== state.executionInstanceId) return false;
  if (value.agentExecution.stageId !== state.currentStageId || selected.stageId !== state.currentStageId) return false;
  if (MIRRORED_CONTEXT_AXES.some((axis) => value.nextContext[axis] !== value.agentExecution[axis])) return false;
  if (PRESERVED_CONTEXT_AXES.some((axis) => value.precondition.context[axis] !== value.nextContext[axis])) return false;
  // The state names the role the instance runs in. It is checked here rather than left to
  // the producer, because a commit adapter is not bound by the domain's start path. The two
  // state roles agree at version 0: a definition's entry stage must require its entry role,
  // so initialization has nowhere else to take `currentRoleId` from.
  if (value.agentExecution.roleId !== state.currentRoleId) return false;
  if (state.entryRoleId !== state.currentRoleId) return false;
  // A just-minted instance is linked to this one execution and to no snapshot. `includes`
  // would admit links whose counterpart document the bundle does not carry.
  if (state.linkedAgentExecutionIds.length !== 1) return false;
  if (state.linkedAgentExecutionIds[0] !== value.agentExecution.agentExecutionId) return false;
  if (state.linkedSnapshotIds.length !== 0) return false;
  if (value.agentExecution.sessionId === undefined) return value.sessionUpdate === undefined;
  return value.sessionUpdate?.sessionId === value.agentExecution.sessionId
    && value.sessionUpdate.addAgentExecutionId === value.agentExecution.agentExecutionId;
}, { error: "The workflow start bundle links must describe one execution." }));
export type WorkflowStartCommitRequest = z.infer<typeof WorkflowStartCommitRequest>;
export type WorkflowStartCommitRequestInput = z.input<typeof WorkflowStartCommitRequest>;
export const WorkflowStartResult = WorkflowStartCommitRequest;
export type WorkflowStartResult = WorkflowStartCommitRequest;

export const parseExecutionAuthorizationRequest = (value: unknown): ExecutionAuthorizationRequest => z.parse(ExecutionAuthorizationRequest, value);
export const tryParseExecutionAuthorizationRequest = (value: unknown): ParseOutcome<ExecutionAuthorizationRequest> => tryParseWith(ExecutionAuthorizationRequest, value, "request");
export const parseExecutionAuthorizationResult = (value: unknown): ExecutionAuthorizationResult => z.parse(ExecutionAuthorizationResult, value);
export const tryParseExecutionAuthorizationResult = (value: unknown): ParseOutcome<ExecutionAuthorizationResult> => tryParseWith(ExecutionAuthorizationResult, value, "response");
export const parseWorkflowStartRequest = (value: unknown): WorkflowStartRequest => z.parse(WorkflowStartRequest, value);
export const tryParseWorkflowStartRequest = (value: unknown): ParseOutcome<WorkflowStartRequest> => tryParseWith(WorkflowStartRequest, value, "request");
export const parseWorkflowStartCommitRequest = (value: unknown): WorkflowStartCommitRequest => z.parse(WorkflowStartCommitRequest, value);
export const tryParseWorkflowStartCommitRequest = (value: unknown): ParseOutcome<WorkflowStartCommitRequest> => tryParseWith(WorkflowStartCommitRequest, value, "request");
export const parseWorkflowStartResult = parseWorkflowStartCommitRequest;
export const tryParseWorkflowStartResult = (value: unknown): ParseOutcome<WorkflowStartResult> => tryParseWith(WorkflowStartResult, value, "response");
