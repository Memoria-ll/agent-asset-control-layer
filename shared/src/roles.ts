import * as z from "zod/mini";
import { RoleId, TaskTypeId } from "./identifiers.js";
import { NonEmptyString } from "./primitives.js";
import { tryParseWith, type ParseOutcome } from "./errors.js";

/**
 * Role and task type catalogue entries.
 *
 * Neither carries hierarchy or inheritance: whether roles nest is part of the
 * Core domain definition (#5), and a nesting field here would fix that shape
 * before it is decided.
 */

export const RoleDto = z.strictObject({
  roleId: RoleId,
  displayName: NonEmptyString,
});
export type RoleDto = z.infer<typeof RoleDto>;
export type RoleDtoInput = z.input<typeof RoleDto>;

export const TaskTypeDto = z.strictObject({
  taskTypeId: TaskTypeId,
  displayName: NonEmptyString,
});
export type TaskTypeDto = z.infer<typeof TaskTypeDto>;
export type TaskTypeDtoInput = z.input<typeof TaskTypeDto>;

export const parseRoleDto = (value: unknown): RoleDto => z.parse(RoleDto, value);

export const tryParseRoleDto = (value: unknown): ParseOutcome<RoleDto> =>
  tryParseWith(RoleDto, value);

export const parseTaskTypeDto = (value: unknown): TaskTypeDto =>
  z.parse(TaskTypeDto, value);

export const tryParseTaskTypeDto = (value: unknown): ParseOutcome<TaskTypeDto> =>
  tryParseWith(TaskTypeDto, value);
