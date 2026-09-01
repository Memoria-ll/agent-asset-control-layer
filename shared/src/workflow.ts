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

/**
 * The current state of a workflow instance, addressed by its definition and
 * execution instance identifiers.
 *
 * Each execution instance owns an independent state, and its logical key is
 * `(workflowId, executionInstanceId)`. State versioning and compare-and-swap
 * belong to #7's persistence contract.
 *
 * Completion is expressed by `currentStageId` pointing at a terminal stage; a
 * separate completion field would fix a vocabulary the workflow model (#7) has
 * not defined. Workflow definitions themselves are #7's contract, not this one.
 */
export const WorkflowStateDto = z.strictObject({
  workflowId: WorkflowId,
  executionInstanceId: ExecutionInstanceId,
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
 * One transition a workflow state offers.
 *
 * Candidates that cannot be taken are still returned, with `blocked` set and
 * display reasons attached: deciding the transition is the caller's, so Core
 * must not filter the impossible ones out silently.
 *
 * There is no transition kind field. #7 names retry / reject / return while #39
 * names retry / reject / fallback, and nothing states whether "return" and
 * "fallback" are the same thing; an enum settled here would freeze a vocabulary
 * that matches neither, and both adding and removing an enum member is a
 * breaking change.
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
