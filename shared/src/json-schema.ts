import * as z from "zod/mini";
import { VersionInfo } from "./contract-version.ts";
import { CoreErrorDto } from "./errors.ts";
import { ModelDto, ProviderDto, RuntimeDto } from "./execution-targets.ts";
import { ResolveRequest, ResolveResponse } from "./resolution.ts";
import { ResolvedContextDto } from "./resolved-context.ts";
import { RoleDto, TaskTypeDto } from "./roles.ts";
import { AgentExecutionDto, SessionDto } from "./sessions.ts";
import { TransitionCandidateDto, WorkflowStateDto } from "./workflow.ts";

/**
 * Every type that crosses the network / IPC boundary, in one place.
 *
 * This registry is what makes "each boundary type has an explicit serialization
 * schema" checkable rather than asserted: a DTO missing from here has no
 * published schema, and a component that never crosses the boundary on its own
 * (a resolution reason, a conflict) is not registered.
 */
export const contractSchemas: Readonly<Record<string, z.core.$ZodType>> = {
  ResolveRequest,
  ResolveResponse,
  ResolvedContextDto,
  SessionDto,
  AgentExecutionDto,
  WorkflowStateDto,
  TransitionCandidateDto,
  VersionInfo,
  CoreErrorDto,
  ProviderDto,
  RuntimeDto,
  ModelDto,
  RoleDto,
  TaskTypeDto,
};

/**
 * The registry rendered as JSON Schema draft 2020-12, keyed by schema name.
 *
 * Nested schemas are inlined rather than emitted as `$defs` + `$ref`, so a
 * consumer's validator needs no reference resolution.
 *
 * Returning the value is where this package stops: writing the schemas to disk
 * or serving them is a transport decision (#12).
 */
export const contractJsonSchemas = (): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(contractSchemas).map(([name, schema]) => [
      name,
      z.toJSONSchema(schema),
    ]),
  );
