import * as z from "zod/mini";
import {
  AssetId,
  AssetRevision,
  ModelId,
  ProjectId,
  ProviderId,
  RoleId,
  RuntimeId,
  SkillId,
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

export const EXECUTION_MODES = ["advisory_preparation", "development_execution"] as const;
export const ExecutionMode = z.enum(EXECUTION_MODES);
export type ExecutionMode = z.infer<typeof ExecutionMode>;

const workflowNone = z.strictObject({ kind: z.literal("none") });
const workflowStandalone = z.strictObject({ kind: z.literal("standalone"), skillId: SkillId });
const workflowSelected = z.strictObject({
  kind: z.literal("selected"),
  workflowId: WorkflowId,
  stageId: StageId,
});

const WorkflowSelectionSchema = z.discriminatedUnion("kind", [
  workflowNone,
  workflowStandalone,
  workflowSelected,
]);
const DevelopmentWorkflowSelectionSchema = z.discriminatedUnion("kind", [
  workflowStandalone,
  workflowSelected,
]);
export type WorkflowSelection = z.infer<typeof WorkflowSelectionSchema>;
export type WorkflowSelectionInput = z.input<typeof WorkflowSelectionSchema>;

const resolutionContextAxes = {
  projectId: z.optional(ProjectId),
  taskTypeId: z.optional(TaskTypeId),
  roleId: z.optional(RoleId),
  providerId: z.optional(ProviderId),
  runtimeId: z.optional(RuntimeId),
  modelId: z.optional(ModelId),
  directory: z.optional(DirectoryPath),
};

/**
 * The explicit execution state and dimensions a resolution is evaluated against.
 * Every dimension is optional: a caller resolves against the axes it actually
 * knows.
 *
 * An execution instance id is not among them. Assets declare the scope they
 * apply to, and are authored before any run exists, so an opaque identifier
 * minted when a run starts is a dimension no asset could ever be matched on.
 *
 * The development arm excludes `kind: "none"` so the invalid combination is
 * represented in the emitted JSON Schema as well as by parsing.
 */
const advisoryPreparationContext = z.strictObject({
  executionMode: z.literal("advisory_preparation"),
  workflow: WorkflowSelectionSchema,
  ...resolutionContextAxes,
});
const developmentExecutionContext = z.strictObject({
  executionMode: z.literal("development_execution"),
  workflow: DevelopmentWorkflowSelectionSchema,
  ...resolutionContextAxes,
});
export const ResolutionContextInput = z.discriminatedUnion("executionMode", [
  advisoryPreparationContext,
  developmentExecutionContext,
]);
export type ResolutionContextInput = z.input<typeof ResolutionContextInput>;
export type ResolutionContextDto = z.infer<typeof ResolutionContextInput>;
export type ResolutionContextDtoInput = z.input<typeof ResolutionContextInput>;

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
 * `context` is repeated on the result because reconstructing a past resolved
 * context (#13) needs the input it was produced from.
 */
export const ResolvedContextDto = z.strictObject({
  context: ResolutionContextInput,
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
