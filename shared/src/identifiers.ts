import * as z from "zod/mini";
import { brandedId } from "./internal/branded-id.ts";

/**
 * Every identifier is a distinct branded string. Boundary DTOs carry several
 * identifier fields side by side, and a plain `string` lets two of them be
 * swapped without the type checker noticing.
 *
 * The only value constraint is "non-empty". The permitted character set, the
 * maximum length and case normalisation are NOT constrained by this contract:
 * an identifier may end up mapped onto a filesystem name, and that shape is
 * decided by the asset model (#2) together with the Windows/WSL boundary (#32).
 *
 * Whether an asset keeps its identifier across a rename is likewise #2's
 * decision; these schemas assert string identity only and hold either way.
 */

export const AssetId = brandedId<"AssetId">();
export type AssetId = z.infer<typeof AssetId>;

export const AssetRevision = brandedId<"AssetRevision">();
export type AssetRevision = z.infer<typeof AssetRevision>;

export const ProjectId = brandedId<"ProjectId">();
export type ProjectId = z.infer<typeof ProjectId>;

export const RoleId = brandedId<"RoleId">();
export type RoleId = z.infer<typeof RoleId>;

export const TaskTypeId = brandedId<"TaskTypeId">();
export type TaskTypeId = z.infer<typeof TaskTypeId>;

export const ProviderId = brandedId<"ProviderId">();
export type ProviderId = z.infer<typeof ProviderId>;

export const RuntimeId = brandedId<"RuntimeId">();
export type RuntimeId = z.infer<typeof RuntimeId>;

export const ModelId = brandedId<"ModelId">();
export type ModelId = z.infer<typeof ModelId>;

export const SessionId = brandedId<"SessionId">();
export type SessionId = z.infer<typeof SessionId>;

export const AgentExecutionId = brandedId<"AgentExecutionId">();
export type AgentExecutionId = z.infer<typeof AgentExecutionId>;

export const WorkflowId = brandedId<"WorkflowId">();
export type WorkflowId = z.infer<typeof WorkflowId>;

export const ExecutionInstanceId = brandedId<"ExecutionInstanceId">();
export type ExecutionInstanceId = z.infer<typeof ExecutionInstanceId>;

export const StageId = brandedId<"StageId">();
export type StageId = z.infer<typeof StageId>;

export const SnapshotId = brandedId<"SnapshotId">();
export type SnapshotId = z.infer<typeof SnapshotId>;
