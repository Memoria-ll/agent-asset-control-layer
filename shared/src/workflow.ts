import * as z from "zod/mini";
import {
  AgentExecutionId,
  ExecutionInstanceId,
  RoleId,
  SnapshotId,
  StageId,
  TaskTypeId,
  WorkflowId,
} from "./identifiers.ts";
import { NonEmptyString, Timestamp } from "./primitives.ts";
import { tryParseWith, type ParseOutcome } from "./errors.ts";

export const TRANSITION_KINDS = ["advance", "retry", "reject", "return"] as const;
export const TransitionKind = z.enum(TRANSITION_KINDS);
export type TransitionKind = z.infer<typeof TransitionKind>;

export const WorkflowStateVersion = z.int().check(z.gte(0));
export type WorkflowStateVersion = z.infer<typeof WorkflowStateVersion>;

/**
 * The current snapshot of one workflow instance. Its logical key is
 * `(workflowId, executionInstanceId)`: one definition carries many instances,
 * and each instance owns an independent state.
 *
 * `stateVersion` names the exact snapshot a candidate query returned and the
 * precondition a compare-and-swap update is checked against. `updatedAt` is a
 * display and audit time, not a concurrency token.
 *
 * Completion is read off `currentStageId` reaching the definition's terminal
 * stage, with no separate completion field. A definition is valid only when
 * every stage can reach the terminal stage, so a stage-based test cannot report
 * an instance as running forever, and a second field carrying the same fact
 * would be a second place for it to disagree.
 */
export const WorkflowStateDto = z.strictObject({
  workflowId: WorkflowId,
  executionInstanceId: ExecutionInstanceId,
  stateVersion: WorkflowStateVersion,
  currentStageId: StageId,
  entryRoleId: RoleId,
  currentRoleId: RoleId,
  linkedAgentExecutionIds: z.array(AgentExecutionId),
  linkedSnapshotIds: z.array(SnapshotId),
  updatedAt: Timestamp,
});
export type WorkflowStateDto = z.infer<typeof WorkflowStateDto>;
export type WorkflowStateDtoInput = z.input<typeof WorkflowStateDto>;

/**
 * A requirement list: present means "at least one", and a reference names a requirement
 * rather than counting it, so declaring the same one twice is not a state a definition can
 * be in. The registry entry is what carries `uniqueItems` into the published JSON Schema —
 * a check alone validates here and leaves a schema-driven consumer accepting a definition
 * that Core rejects while resolving it.
 */
const RequirementRefs = z.array(NonEmptyString)
  .check(z.minLength(1))
  .check(z.refine((refs) => new Set(refs).size === refs.length, {
    error: "Requirement references must not repeat.",
  }))
  .register(z.globalRegistry, { uniqueItems: true });

export const WorkflowStageDto = z.strictObject({
  stageId: StageId,
  displayName: NonEmptyString,
  description: NonEmptyString,
  requiredRoleId: z.optional(RoleId),
  requiredTaskTypeId: z.optional(TaskTypeId),
  requiredArtifactRefs: z.optional(RequirementRefs),
  requiredCapabilityRefs: z.optional(RequirementRefs),
});
export type WorkflowStageDto = z.infer<typeof WorkflowStageDto>;
export type WorkflowStageDtoInput = z.input<typeof WorkflowStageDto>;

export const WorkflowTransitionDto = z.strictObject({
  fromStageId: StageId,
  toStageId: StageId,
  transitionKind: TransitionKind,
  requiredArtifactRefs: z.optional(RequirementRefs),
  requiredCapabilityRefs: z.optional(RequirementRefs),
});
export type WorkflowTransitionDto = z.infer<typeof WorkflowTransitionDto>;
export type WorkflowTransitionDtoInput = z.input<typeof WorkflowTransitionDto>;

/**
 * The size a workflow graph may reach.
 *
 * A definition is a hand-authored asset, so the bounds sit far above any workflow a person
 * writes while keeping the graph small enough that whole-graph work (cycle detection,
 * per-transition evaluation) is bounded by the contract rather than by whatever the
 * implementation happens to cost. The transition bound is the wider of the two because a
 * dense graph declares more edges than stages.
 *
 * These reach consumers as `maxItems` in the published JSON Schema, not as exported constants:
 * the schema is the contract's carrier, and the index publishes no numeric surface.
 */
export const WORKFLOW_STAGE_LIMIT = 1000;
export const WORKFLOW_TRANSITION_LIMIT = 4000;

/**
 * A workflow definition as it crosses the boundary.
 *
 * `workflowId` is optional because the on-disk form carries the identifier in
 * the asset's `id` frontmatter field rather than in the definition body: the
 * loader fills it in from the asset when the body omits it, and rejects a body
 * naming a different one. Requiring it here would leave the published schema
 * describing a document no author can write.
 *
 * `transitions` may be empty — a definition whose entry stage is also its
 * terminal stage declares no edges.
 */
export const WorkflowDefinitionDto = z.strictObject({
  workflowId: z.optional(WorkflowId),
  entryRoleId: RoleId,
  entryStageId: StageId,
  terminalStageId: StageId,
  stages: z.array(WorkflowStageDto).check(z.minLength(1)).check(z.maxLength(WORKFLOW_STAGE_LIMIT)),
  transitions: z.array(WorkflowTransitionDto).check(z.maxLength(WORKFLOW_TRANSITION_LIMIT)),
});
export type WorkflowDefinitionDto = z.infer<typeof WorkflowDefinitionDto>;
export type WorkflowDefinitionDtoInput = z.input<typeof WorkflowDefinitionDto>;

/**
 * One transition a workflow state offers.
 *
 * Candidates that cannot be taken are still returned, with `blocked` set and
 * display reasons attached: deciding the transition is the caller's, so Core
 * must not filter the impossible ones out silently.
 *
 * `stateVersion` travels with each candidate so a caller can preserve the
 * snapshot used for its compare-and-swap decision. It belongs on the candidate
 * rather than a response envelope because the envelope is owned by the
 * transport contract and each candidate must remain independently actionable.
 *
 * Blocked and unblocked are separate arms rather than one object holding a
 * `blocked` flag beside a free-standing reason list. A single object admits both
 * `blocked: true` with no reasons and `blocked: false` with reasons, leaving the
 * consumer to render an unexplained block or to discard reasons Core supplied.
 * The split is what carries the constraint into `contractJsonSchemas()` as well:
 * a cross-field `z.refine` enforces it in the parser only and emits nothing into
 * the JSON Schema, so a schema-driven consumer would still accept both.
 *
 * `blockedReasons` is absent from the unblocked arm rather than pinned to an
 * empty array, because `z.strictObject` then rejects the key outright and the
 * TypeScript type only exposes it once `blocked` has been narrowed to `true`.
 */
const transitionCandidateFields = {
  toStageId: StageId,
  transitionKind: TransitionKind,
  stateVersion: WorkflowStateVersion,
  requiredRoleId: z.optional(RoleId),
  requiredTaskTypeId: z.optional(TaskTypeId),
};

export const TransitionCandidateDto = z.discriminatedUnion("blocked", [
  z.strictObject({
    ...transitionCandidateFields,
    blocked: z.literal(false),
  }),
  z.strictObject({
    ...transitionCandidateFields,
    blocked: z.literal(true),
    blockedReasons: z.array(NonEmptyString).check(z.minLength(1)),
  }),
]);
export type TransitionCandidateDto = z.infer<typeof TransitionCandidateDto>;
export type TransitionCandidateDtoInput = z.input<typeof TransitionCandidateDto>;

export const parseWorkflowStateDto = (value: unknown): WorkflowStateDto =>
  z.parse(WorkflowStateDto, value);

export const tryParseWorkflowStateDto = (
  value: unknown,
): ParseOutcome<WorkflowStateDto> => tryParseWith(WorkflowStateDto, value, "response");

export const parseTransitionCandidateDto = (
  value: unknown,
): TransitionCandidateDto => z.parse(TransitionCandidateDto, value);

export const tryParseTransitionCandidateDto = (
  value: unknown,
): ParseOutcome<TransitionCandidateDto> =>
  tryParseWith(TransitionCandidateDto, value, "response");

export const parseWorkflowDefinitionDto = (value: unknown): WorkflowDefinitionDto =>
  z.parse(WorkflowDefinitionDto, value);

export const tryParseWorkflowDefinitionDto = (
  value: unknown,
): ParseOutcome<WorkflowDefinitionDto> =>
  tryParseWith(WorkflowDefinitionDto, value, "response");
