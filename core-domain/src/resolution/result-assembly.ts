import type { AssetId, ConflictDto, CoreErrorDetail, ResolutionReason } from "@aacl/shared";
import { codeUnitCompare } from "../ordering.ts";
import { RESOLUTION_AXES } from "./resolution-context.ts";
import type { CandidateReason, CandidateState, ResolutionConflict, ResolutionRank } from "./resolution-types.ts";
import { canonicalCapabilityDependencyKeys } from "./candidate-validation.ts";
import { compareRank } from "./ranking-precedence.ts";

export const sortedUniqueIds = (ids: readonly AssetId[]): readonly AssetId[] =>
  [...new Set(ids)].sort(codeUnitCompare);

export const conflictKey = (conflict: ResolutionConflict): string => {
  switch (conflict.kind) {
    case "exclusive_tie": return `${conflict.kind}:${conflict.mergeGroup}:${conflict.involvedAssetIds.join("\u0000")}`;
    case "operation_conflict": return `${conflict.kind}:${conflict.targetAssetId}:${conflict.involvedAssetIds.join("\u0000")}`;
    case "duplicate_identity": return `${conflict.kind}:${conflict.assetId}:${conflict.involvedAssetIds.join("\u0000")}`;
    case "dependency_failure": return `${conflict.kind}:${conflict.failedRequirement}:${conflict.involvedAssetIds.join("\u0000")}`;
    case "capability_failure": return `${conflict.kind}:${conflict.failedCapabilities.join("\u0000")}:${conflict.involvedAssetIds.join("\u0000")}`;
    default: return `${conflict.kind}:${conflict.involvedAssetIds.join("\u0000")}`;
  }
};

export const canonicalIds = (ids: readonly AssetId[]): readonly AssetId[] => sortedUniqueIds(ids);


export const resolutionConflictReason = (conflict: ResolutionConflict, rank?: ResolutionRank): CandidateReason => ({
  kind: "excluded",
  cause: "resolution_conflict",
  conflict,
  ...(rank === undefined ? {} : { rank }),
});

export const compareCandidatesForOutput = (left: CandidateState, right: CandidateState): number => {
  if (left.rank !== undefined && right.rank === undefined) return -1;
  if (left.rank === undefined && right.rank !== undefined) return 1;
  if (left.rank !== undefined && right.rank !== undefined) {
    const rankOrder = compareRank(right.rank, left.rank);
    if (rankOrder !== 0) return rankOrder;
  }
  const assetOrder = codeUnitCompare(String(left.candidate.assetId), String(right.candidate.assetId));
  if (assetOrder !== 0) return assetOrder;
  const revisionOrder = codeUnitCompare(String(left.candidate.revision), String(right.candidate.revision));
  if (revisionOrder !== 0) return revisionOrder;
  const sourceOrder = codeUnitCompare(String(left.candidate.source.sourceId), String(right.candidate.source.sourceId));
  if (sourceOrder !== 0) return sourceOrder;

  const leftCandidate = left.candidate;
  const rightCandidate = right.candidate;
  const payloadTypeOrder = codeUnitCompare(String(leftCandidate.assetType), String(rightCandidate.assetType));
  if (payloadTypeOrder !== 0) return payloadTypeOrder;
  const loadingTierOrder = codeUnitCompare(String(leftCandidate.loadingTier), String(rightCandidate.loadingTier));
  if (loadingTierOrder !== 0) return loadingTierOrder;
  const sourceLayerOrder = codeUnitCompare(leftCandidate.source.layer, rightCandidate.source.layer);
  if (sourceLayerOrder !== 0) return sourceLayerOrder;

  const leftRule = leftCandidate.rule;
  const rightRule = rightCandidate.rule;
  if (leftRule.mandatory !== rightRule.mandatory) return leftRule.mandatory ? 1 : -1;
  const operationKindOrder = codeUnitCompare(leftRule.operation.kind, rightRule.operation.kind);
  if (operationKindOrder !== 0) return operationKindOrder;
  if (leftRule.operation.kind !== "add" && rightRule.operation.kind !== "add") {
    const targetOrder = codeUnitCompare(String(leftRule.operation.targetAssetId), String(rightRule.operation.targetAssetId));
    if (targetOrder !== 0) return targetOrder;
  }
  if (leftRule.explicitPriority !== undefined && rightRule.explicitPriority === undefined) return 1;
  if (leftRule.explicitPriority === undefined && rightRule.explicitPriority !== undefined) return -1;
  if (leftRule.explicitPriority !== undefined && rightRule.explicitPriority !== undefined && leftRule.explicitPriority !== rightRule.explicitPriority) {
    return leftRule.explicitPriority - rightRule.explicitPriority;
  }
  const mergeModeOrder = codeUnitCompare(leftRule.mergeMode, rightRule.mergeMode);
  if (mergeModeOrder !== 0) return mergeModeOrder;
  if (leftRule.mergeGroup !== undefined && rightRule.mergeGroup === undefined) return 1;
  if (leftRule.mergeGroup === undefined && rightRule.mergeGroup !== undefined) return -1;
  if (leftRule.mergeGroup !== undefined && rightRule.mergeGroup !== undefined) {
    const mergeGroupOrder = codeUnitCompare(leftRule.mergeGroup, rightRule.mergeGroup);
    if (mergeGroupOrder !== 0) return mergeGroupOrder;
  }
  const requiresLengthOrder = leftRule.requires.length - rightRule.requires.length;
  if (requiresLengthOrder !== 0) return requiresLengthOrder;
  for (let index = 0; index < leftRule.requires.length; index += 1) {
    const requirementOrder = codeUnitCompare(leftRule.requires[index] as string, rightRule.requires[index] as string);
    if (requirementOrder !== 0) return requirementOrder;
  }
  const leftCapabilityDependencies = canonicalCapabilityDependencyKeys(leftRule.capabilityDependencies);
  const rightCapabilityDependencies = canonicalCapabilityDependencyKeys(rightRule.capabilityDependencies);
  const capabilityDependencyLengthOrder = leftCapabilityDependencies.length - rightCapabilityDependencies.length;
  if (capabilityDependencyLengthOrder !== 0) return capabilityDependencyLengthOrder;
  for (let index = 0; index < leftCapabilityDependencies.length; index += 1) {
    const dependencyOrder = codeUnitCompare(leftCapabilityDependencies[index]!, rightCapabilityDependencies[index]!);
    if (dependencyOrder !== 0) return dependencyOrder;
  }
  for (const axis of RESOLUTION_AXES) {
    const leftSelectors = leftRule.selectors[axis];
    const rightSelectors = rightRule.selectors[axis];
    if (leftSelectors !== undefined && rightSelectors === undefined) return 1;
    if (leftSelectors === undefined && rightSelectors !== undefined) return -1;
    if (leftSelectors === undefined || rightSelectors === undefined) continue;
    const selectorLengthOrder = leftSelectors.length - rightSelectors.length;
    if (selectorLengthOrder !== 0) return selectorLengthOrder;
    for (let index = 0; index < leftSelectors.length; index += 1) {
      const selectorOrder = codeUnitCompare(leftSelectors[index] as string, rightSelectors[index] as string);
      if (selectorOrder !== 0) return selectorOrder;
    }
  }
  return 0;
};

export const conflictExplanation = (conflict: ResolutionConflict): string => {
  switch (conflict.kind) {
    // Covers a cycle as well as an equal rank: neither leaves a candidate that beats all others.
    case "exclusive_tie": return "Exclusive candidates have no single highest-ranked candidate.";
    case "mandatory_conflict": return "Mandatory candidates cannot be resolved together.";
    case "operation_conflict": return "Conflicting operations target the same asset.";
    case "duplicate_identity": return "Candidates with the same asset identity have different meanings.";
    case "dependency_cycle": return "Asset requirements contain a cycle.";
    case "dependency_failure": return "A mandatory asset requirement could not be satisfied.";
    case "asset_type_conflict": return "Candidates of different asset types cannot be combined.";
    case "capability_failure": return `Mandatory capability dependencies could not be satisfied: ${conflict.failedCapabilities.join(", ")}.`;
  }
};

export const toResolutionReasonDto = (reason: CandidateReason): ResolutionReason => {
  switch (reason.kind) {
    case "included": return {
      kind: "included",
      explanation: reason.degradedInfo === undefined
        ? "The candidate matched the requested scope."
        : `The candidate matched the requested scope. ${reason.degradedInfo.reasons.join(" ")}`,
    };
    case "excluded": {
      if (reason.cause === "scope_mismatch") return { kind: "excluded", explanation: "The candidate did not match the requested scope." };
      if (reason.cause === "invalid_directory") return { kind: "excluded", explanation: "The candidate has an invalid directory selector." };
      return { kind: "excluded", explanation: "The candidate participated in a resolution conflict." };
    }
    case "overridden": return { kind: "overridden", explanation: "The candidate was overridden by a higher-ranked candidate.", overriddenBy: reason.overriddenBy };
    case "disabled": return { kind: "disabled", explanation: "The candidate was disabled by an operation.", disabledBy: reason.disabledBy };
    case "unavailable": return { kind: "unavailable", explanation: "The candidate is unavailable because a requirement failed.", availability: reason.availability };
  }
};

export const toResolutionConflictDto = (conflict: ResolutionConflict): ConflictDto => ({
  explanation: conflictExplanation(conflict),
  involvedAssetIds: [...canonicalIds(conflict.involvedAssetIds)],
});

/**
 * One detail per involved asset, with the id in `path`.
 *
 * The ids do not go into `message`: a consumer would then have to parse prose for this
 * failure while reading `path` for every other one, which is the same split the asset
 * store already refuses to introduce.
 */
export const toResolutionConflictDetails = (
  conflict: ResolutionConflict,
): readonly CoreErrorDetail[] => canonicalIds(conflict.involvedAssetIds).map((assetId) => ({
  path: ["resolution", "conflict", conflict.kind, assetId],
  code: conflict.kind,
  message: conflictExplanation(conflict),
}));
