import * as z from "zod/mini";
import {
  AgentExecutionId,
  RoleId,
  SnapshotId,
  StageId,
  TaskTypeId,
  WorkflowId,
} from "./identifiers.js";
import { Timestamp } from "./primitives.js";
import { tryParseWith, type ParseOutcome } from "./errors.js";

/**
 * The current state of one workflow instance.
 *
 * Completion is expressed by `currentStageId` pointing at a terminal stage; a
 * separate completion field would fix a vocabulary the workflow model (#7) has
 * not defined. Workflow definitions themselves are #7's contract, not this one.
 */
export const WorkflowStateDto = z.strictObject({
  workflowId: WorkflowId,
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
 */
export const TransitionCandidateDto = z.strictObject({
  toStageId: StageId,
  requiredRoleId: z.optional(RoleId),
  requiredTaskTypeId: z.optional(TaskTypeId),
  blocked: z.boolean(),
  blockedReasons: z.array(z.string()),
});
export type TransitionCandidateDto = z.infer<typeof TransitionCandidateDto>;
export type TransitionCandidateDtoInput = z.input<typeof TransitionCandidateDto>;

export const parseWorkflowStateDto = (value: unknown): WorkflowStateDto =>
  z.parse(WorkflowStateDto, value);

export const tryParseWorkflowStateDto = (
  value: unknown,
): ParseOutcome<WorkflowStateDto> => tryParseWith(WorkflowStateDto, value);

export const parseTransitionCandidateDto = (
  value: unknown,
): TransitionCandidateDto => z.parse(TransitionCandidateDto, value);

export const tryParseTransitionCandidateDto = (
  value: unknown,
): ParseOutcome<TransitionCandidateDto> =>
  tryParseWith(TransitionCandidateDto, value);
