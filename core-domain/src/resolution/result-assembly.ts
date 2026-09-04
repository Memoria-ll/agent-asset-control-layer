import type { AssetId, ConflictDto, CoreErrorDetail, ResolutionReason } from "@aacl/shared";
import type { AssetResult } from "../failures.ts";
import { codeUnitCompare } from "../ordering.ts";
import { RESOLUTION_AXES, type ResolutionContext } from "./resolution-context.ts";
import type { CandidateReason, CandidateState, OperationConflictEntry, OperationPass, ResolutionConflict, ResolutionRank, ResolutionResult, SelectionPass } from "./resolution-types.ts";
import { canonicalCapabilityDependencyKeys } from "./candidate-validation.ts";
import { compareRank } from "./ranking-precedence.ts";

export type ResultAssemblyContext = {
  readonly context: ResolutionContext;
  readonly states: readonly CandidateState[];
  readonly invalidStates: readonly CandidateState[];
  readonly conflicts: ReadonlyMap<string, ResolutionConflict>;
  readonly addConflict: (conflict: ResolutionConflict) => void;
  readonly baseIncluded: ReadonlySet<CandidateState>;
  readonly baseReasons: ReadonlyMap<CandidateState, CandidateReason>;
  readonly selectionEvidence: Map<CandidateState, CandidateReason>;
  readonly selectionExcluded: ReadonlySet<CandidateState>;
  readonly finalSelection: SelectionPass;
  readonly operationResult: { readonly pass: OperationPass; readonly forcedConflicts: ReadonlyMap<CandidateState, ResolutionConflict> };
};

export const assembleResult = (ctx: ResultAssemblyContext): AssetResult<ResolutionResult> => {
  const { context, states, invalidStates, conflicts, addConflict, baseIncluded, baseReasons,
          selectionEvidence, selectionExcluded, finalSelection, operationResult } = ctx;
  const finalPass = operationResult.pass;
  const forcedConflicts = operationResult.forcedConflicts;
  for (const state of selectionExcluded) {
    const evidence = selectionEvidence.get(state);
    const status = finalPass.statuses.get(state);
    if (status?.kind === "disabled") {
      selectionEvidence.set(state, { kind: "disabled", disabledBy: status.disabledBy });
      continue;
    }
    if (status?.kind === "overridden") {
      selectionEvidence.set(state, {
        kind: "overridden",
        overriddenBy: status.overriddenBy,
        mergeGroup: status.mergeGroup,
        winnerRank: status.winnerRank,
      });
      continue;
    }
    if (evidence?.kind === "excluded" && evidence.cause === "resolution_conflict") {
      if (state.candidate.rule.mergeMode !== "exclusive") continue;
      const winner = finalSelection.exclusiveWinners.find((candidate) =>
        candidate.candidate.rule.mergeGroup === state.candidate.rule.mergeGroup
      );
      if (
        winner !== undefined &&
        winner.candidate.rule.mergeMode === "exclusive" &&
        finalPass.statuses.get(winner)?.kind === "included"
      ) {
        selectionEvidence.set(state, {
          kind: "overridden",
          overriddenBy: winner.candidate.assetId,
          mergeGroup: winner.candidate.rule.mergeGroup,
          winnerRank: winner.rank!,
        });
      }
      continue;
    }
  }

  const finalReasons = new Map<CandidateState, CandidateReason>();
  for (const state of states) {
    const evidence = selectionEvidence.get(state);
    if (evidence !== undefined) {
      finalReasons.set(state, evidence);
      continue;
    }
    if (!baseIncluded.has(state)) {
      finalReasons.set(state, baseReasons.get(state)!);
      continue;
    }
    const status = finalPass.statuses.get(state) ?? { kind: "included" as const };
    if (status.kind === "disabled") {
      finalReasons.set(state, { kind: "disabled", disabledBy: status.disabledBy });
    } else if (status.kind === "overridden") {
      finalReasons.set(state, {
        kind: "overridden",
        overriddenBy: status.overriddenBy,
        mergeGroup: status.mergeGroup,
        winnerRank: status.winnerRank,
      });
    } else if (status.kind === "conflict") {
      finalReasons.set(state, resolutionConflictReason(status.conflict, state.rank));
    } else {
      const outcome = finalPass.dependency.get(state)!;
      if (outcome.ok) {
        finalReasons.set(state, {
          ...baseReasons.get(state)!,
          ...(outcome.degradedInfo === undefined ? {} : { degradedInfo: outcome.degradedInfo }),
          ...(outcome.degradedCapabilities === undefined ? {} : { degradedCapabilities: outcome.degradedCapabilities }),
        });
      } else {
        finalReasons.set(state, {
          kind: "unavailable",
          availability: "unavailable",
          cause: outcome.cause,
          failedRequirements: [...outcome.failedRequirements],
          ...(outcome.failedCapabilities === undefined ? {} : { failedCapabilities: outcome.failedCapabilities }),
        });
      }
    }
  }
  for (const reason of finalReasons.values()) {
    if (reason.kind === "excluded" && reason.cause === "resolution_conflict") {
      addConflict(reason.conflict);
    }
  }

  // Only conflicts whose issuer remains a resolution conflict survive.  A
  // failed operation on a candidate disabled by another surviving operation
  // is diagnostic noise and must not turn a resolved result into conflicted.
  const operationConflictEntries: OperationConflictEntry[] = [];
  operationConflictEntries.push(...finalPass.operationConflicts);
  operationConflictEntries.push(...finalPass.failures.map((failure) => ({ conflict: failure.conflict, issuers: [failure.issuer] })));
  for (const [issuer, conflict] of forcedConflicts) operationConflictEntries.push({ conflict, issuers: [issuer] });
  for (const entry of operationConflictEntries) {
    if (entry.issuers.some((issuer) => {
      const reason = finalReasons.get(issuer);
      return reason?.kind === "excluded" && reason.cause === "resolution_conflict";
    })) addConflict(entry.conflict);
  }
  for (const conflict of finalSelection.conflicts) addConflict(conflict);

  for (const state of states) {
    const reason = finalReasons.get(state)!;
    if (reason.kind !== "unavailable" || !state.candidate.rule.mandatory) continue;
    const outcome = finalPass.dependency.get(state)!;
    if (outcome.ok) continue;
    if (outcome.failedCapabilities !== undefined && outcome.failedCapabilities.length > 0) {
      addConflict({
        kind: "capability_failure",
        failedCapabilities: [...outcome.failedCapabilities],
        involvedAssetIds: [state.candidate.assetId],
      });
    }
    if (outcome.cycleIds !== undefined) {
      addConflict({
        kind: "dependency_cycle",
        involvedAssetIds: canonicalIds([state.candidate.assetId, ...outcome.cycleIds]),
      });
    }
    if (outcome.nonCycleFailedRequirements.length > 0) {
      addConflict({
        kind: "dependency_failure",
        failedRequirement: outcome.nonCycleFailedRequirements[0]!,
        involvedAssetIds: canonicalIds([state.candidate.assetId, ...outcome.failedRequirements]),
      });
    }
  }

  const allStates = [...states, ...invalidStates].sort(compareCandidatesForOutput);
  const resultConflicts = [...conflicts.values()].sort((left, right) => {
    const kindOrder = codeUnitCompare(left.kind, right.kind);
    if (kindOrder !== 0) return kindOrder;
    return codeUnitCompare(conflictKey(left), conflictKey(right));
  });
  return {
    ok: true,
    value: {
      scope: context,
      evaluations: allStates.map((state) => ({ candidate: state.candidate, reason: finalReasons.get(state) ?? state.reason })),
      outcome: resultConflicts.length === 0 ? "resolved" : "conflicted",
      conflicts: resultConflicts,
    },
  };
};

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
      matchedAxes: [...reason.matchedAxes],
      ...(reason.degradedInfo === undefined ? {} : { degradedInfo: reason.degradedInfo }),
      ...(reason.degradedCapabilities === undefined ? {} : {
        degradedCapabilities: reason.degradedCapabilities.map((degradation) => ({
          capabilityId: degradation.capabilityId,
          strength: degradation.strength,
          ...(degradation.fallbackCapabilityId === undefined ? {} : {
            fallbackCapabilityId: degradation.fallbackCapabilityId,
          }),
        })),
      }),
    };
    case "excluded": {
      if (reason.cause === "scope_mismatch") return {
        kind: "excluded",
        explanation: "The candidate did not match the requested scope.",
        detail: { cause: "scope_mismatch", matchedAxes: [...reason.matchedAxes] },
      };
      if (reason.cause === "invalid_directory") return {
        kind: "excluded",
        explanation: "The candidate has an invalid directory selector.",
        detail: { cause: "invalid_directory", diagnostics: [...reason.diagnostics] },
      };
      return {
        kind: "excluded",
        explanation: "The candidate participated in a resolution conflict.",
        detail: { cause: "resolution_conflict", conflict: toResolutionConflictDto(reason.conflict) },
      };
    }
    case "overridden": return {
      kind: "overridden",
      explanation: "The candidate was overridden by a higher-ranked candidate.",
      overriddenBy: reason.overriddenBy,
      mergeGroup: reason.mergeGroup,
    };
    case "disabled": return { kind: "disabled", explanation: "The candidate was disabled by an operation.", disabledBy: reason.disabledBy };
    case "unavailable": {
      const requirementCause = reason.cause === "missing_requirement" ||
        reason.cause === "requirement_out_of_scope" ||
        reason.cause === "requirement_disabled" ||
        reason.cause === "requirement_overridden" ||
        reason.cause === "requirement_cycle" ||
        reason.cause === "requirement_invalid";
      return {
        kind: "unavailable",
        explanation: "The candidate is unavailable because a requirement failed.",
        availability: "unavailable",
        detail: requirementCause
          ? { cause: reason.cause, failedRequirements: [...reason.failedRequirements] }
          : {
              cause: reason.cause,
              failedCapabilities: [...(reason.failedCapabilities ?? [])],
              ...(reason.failedRequirements.length === 0 ? {} : { failedRequirements: [...reason.failedRequirements] }),
            },
      };
    }
  }
};

const canonicalStrings = (values: readonly string[]): readonly string[] =>
  [...new Set(values)].sort(codeUnitCompare);

export const toResolutionConflictDto = (conflict: ResolutionConflict): ConflictDto => {
  const involvedAssetIds = [...canonicalIds(conflict.involvedAssetIds)];
  switch (conflict.kind) {
    case "exclusive_tie": return {
      kind: "exclusive_tie",
      explanation: conflictExplanation(conflict),
      mergeGroup: conflict.mergeGroup,
      involvedAssetIds,
    };
    case "mandatory_conflict": return {
      kind: "mandatory_conflict",
      explanation: conflictExplanation(conflict),
      involvedAssetIds,
    };
    case "operation_conflict": return {
      kind: "operation_conflict",
      explanation: conflictExplanation(conflict),
      targetAssetId: conflict.targetAssetId,
      involvedAssetIds,
    };
    case "duplicate_identity": return {
      kind: "duplicate_identity",
      explanation: conflictExplanation(conflict),
      assetId: conflict.assetId,
      involvedAssetIds,
    };
    case "dependency_cycle": return {
      kind: "dependency_cycle",
      explanation: conflictExplanation(conflict),
      involvedAssetIds,
    };
    case "dependency_failure": return {
      kind: "dependency_failure",
      explanation: conflictExplanation(conflict),
      failedRequirement: conflict.failedRequirement,
      involvedAssetIds,
    };
    case "asset_type_conflict": return {
      kind: "asset_type_conflict",
      explanation: conflictExplanation(conflict),
      involvedAssetIds,
    };
    case "capability_failure": return {
      kind: "capability_failure",
      explanation: conflictExplanation(conflict),
      failedCapabilities: [...canonicalStrings(conflict.failedCapabilities)],
      involvedAssetIds,
    };
  }
};

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
