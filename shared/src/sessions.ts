import * as z from "zod/mini";
import {
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
  WorkflowId,
} from "./identifiers.js";
import { Timestamp } from "./primitives.js";
import { tryParseWith, type ParseOutcome } from "./errors.js";

/**
 * A user session and the agent executions linked to it.
 *
 * The two sides of that link are deliberately asymmetric: `sessionId` is
 * optional on an execution because an agent execution may legitimately exist
 * without ever being a user-facing chat (#20), while a session without
 * executions is expressed by an empty array. Absence is always a missing key,
 * never `null`.
 */

export const SessionDto = z.strictObject({
  sessionId: SessionId,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  projectId: z.optional(ProjectId),
  agentExecutionIds: z.array(AgentExecutionId),
  snapshotIds: z.array(SnapshotId),
});
export type SessionDto = z.infer<typeof SessionDto>;
export type SessionDtoInput = z.input<typeof SessionDto>;

/**
 * One agent execution and the metadata it was started with.
 *
 * There is no execution status field: the vocabulary for it is undecided
 * (#20/#38), and the workflow transition vocabulary (#39) describes a different
 * axis. An optional field can be added later without breaking a producer.
 */
export const AgentExecutionDto = z.strictObject({
  agentExecutionId: AgentExecutionId,
  sessionId: z.optional(SessionId),
  projectId: z.optional(ProjectId),
  workflowId: z.optional(WorkflowId),
  stageId: z.optional(StageId),
  taskTypeId: z.optional(TaskTypeId),
  roleId: z.optional(RoleId),
  providerId: z.optional(ProviderId),
  runtimeId: z.optional(RuntimeId),
  modelId: z.optional(ModelId),
  startedAt: Timestamp,
  endedAt: z.optional(Timestamp),
  snapshotId: z.optional(SnapshotId),
});
export type AgentExecutionDto = z.infer<typeof AgentExecutionDto>;
export type AgentExecutionDtoInput = z.input<typeof AgentExecutionDto>;

export const parseSessionDto = (value: unknown): SessionDto =>
  z.parse(SessionDto, value);

export const tryParseSessionDto = (value: unknown): ParseOutcome<SessionDto> =>
  tryParseWith(SessionDto, value, "response");

export const parseAgentExecutionDto = (value: unknown): AgentExecutionDto =>
  z.parse(AgentExecutionDto, value);

export const tryParseAgentExecutionDto = (
  value: unknown,
): ParseOutcome<AgentExecutionDto> => tryParseWith(AgentExecutionDto, value, "response");
