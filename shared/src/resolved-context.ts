import * as z from "zod/mini";
import {
  AssetId,
  AssetRevision,
  ModelId,
  ProjectId,
  ProviderId,
  RoleId,
  RuntimeId,
  StageId,
  TaskTypeId,
  WorkflowId,
} from "./identifiers.ts";
import { AssetCount, DirectoryPath, Timestamp, TokenCount } from "./primitives.ts";
import { ConflictDto, ResolutionReason } from "./status.ts";
import { tryParseWith, type ParseOutcome } from "./errors.ts";

/**
 * The vocabulary of asset types crossing the boundary.
 *
 * This set is the boundary vocabulary only. Whether the on-disk `type:` of a
 * canonical asset uses the same words is the asset model's decision (#2); this
 * contract claims no agreement with the file shape.
 */
export const ASSET_TYPES = [
  "skill",
  "rule",
  "role",
  "workflow",
  "task-type",
  "policy",
  "guardrail",
  "knowledge",
] as const;
export const AssetType = z.enum(ASSET_TYPES);
export type AssetType = z.infer<typeof AssetType>;

/** How eagerly an asset is loaded. */
export const LOADING_TIERS = ["core", "discoverable", "on-demand"] as const;
export const LoadingTier = z.enum(LOADING_TIERS);
export type LoadingTier = z.infer<typeof LoadingTier>;

/**
 * The dimensions a resolution is evaluated against. Every axis is optional: a
 * caller resolves against the axes it actually knows.
 *
 * It is defined here rather than beside `ResolveRequest` because a resolved
 * context embeds the scope it was resolved for, while a resolve response embeds
 * the resolved context — the reverse placement makes the two modules import each
 * other.
 */
export const ResolutionScopeInput = z.strictObject({
  projectId: z.optional(ProjectId),
  workflowId: z.optional(WorkflowId),
  stageId: z.optional(StageId),
  taskTypeId: z.optional(TaskTypeId),
  roleId: z.optional(RoleId),
  providerId: z.optional(ProviderId),
  runtimeId: z.optional(RuntimeId),
  modelId: z.optional(ModelId),
  directory: z.optional(DirectoryPath),
});
// `z.input`, matching the name and every other `*Input` alias: a caller
// composes a scope from plain strings, and identifier brands exist only on
// the parsed side. A parsed scope is still assignable here, because a branded
// string is a string.
export type ResolutionScopeInput = z.input<typeof ResolutionScopeInput>;

/** One asset the resolution decided on, carrying the reason for that decision. */
export const ResolvedAssetDto = z.strictObject({
  assetId: AssetId,
  revision: AssetRevision,
  assetType: AssetType,
  loadingTier: LoadingTier,
  reason: ResolutionReason,
  /**
   * Absent for tiers that expose metadata without loading the body (#10).
   *
   * Unconstrained rather than a `NonEmptyString`: an asset file with no content
   * is a real asset, and `""` reports its body faithfully. Absence carries the
   * separate meaning that the body was not loaded.
   */
  body: z.optional(z.string()),
  /** Consumed by #10 and by the context cost display (#37). */
  tokenEstimate: z.optional(TokenCount),
});
export type ResolvedAssetDto = z.infer<typeof ResolvedAssetDto>;
export type ResolvedAssetDtoInput = z.input<typeof ResolvedAssetDto>;

/**
 * Aggregate cost of one resolved context. No per-tier or per-asset breakdown:
 * a consumer can aggregate `ResolvedAssetDto.tokenEstimate` itself, and a second
 * copy of the same numbers can disagree with the first.
 */
export const ContextCostDto = z.strictObject({
  totalTokenEstimate: TokenCount,
  includedAssetCount: AssetCount,
  excludedAssetCount: AssetCount,
});
export type ContextCostDto = z.infer<typeof ContextCostDto>;
export type ContextCostDtoInput = z.input<typeof ContextCostDto>;

/**
 * The full result of a resolution.
 *
 * `scope` is repeated on the result because reconstructing a past resolved
 * context (#13) needs the input it was produced from.
 */
export const ResolvedContextDto = z.strictObject({
  scope: ResolutionScopeInput,
  assets: z.array(ResolvedAssetDto),
  conflicts: z.array(ConflictDto),
  cost: ContextCostDto,
  resolvedAt: Timestamp,
});
export type ResolvedContextDto = z.infer<typeof ResolvedContextDto>;
export type ResolvedContextDtoInput = z.input<typeof ResolvedContextDto>;

export const parseResolvedContextDto = (value: unknown): ResolvedContextDto =>
  z.parse(ResolvedContextDto, value);

export const tryParseResolvedContextDto = (
  value: unknown,
): ParseOutcome<ResolvedContextDto> => tryParseWith(ResolvedContextDto, value, "response");
