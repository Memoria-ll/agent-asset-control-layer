import type { ResolutionAxis } from "./resolution-context.ts";
import type { CandidateState, ExclusiveDecision, RankedCandidate, ResolutionConflict, ResolutionRank, ResolutionSourceLayer } from "./resolution-types.ts";
import { canonicalIds, resolutionConflictReason } from "./result-assembly.ts";

/**
 * The more specific layer wins, so a personal asset overrides a global one.
 *
 * Ranking a global asset above a personal one is not the way a global asset is
 * protected: `mandatory` is. Layer order decides which of two interchangeable
 * candidates is preferred; a global asset that must survive a personal override
 * declares itself mandatory, and the hard rule then holds regardless of rank.
 */
export const sourceLayerPrecedence = (layer: ResolutionSourceLayer): 0 | 1 | 2 => {
  switch (layer) {
    case "global": return 0;
    case "personal": return 1;
    case "project": return 2;
  }
};

/**
 * The default scope precedence, keyed by the resolver axis vocabulary rather than the
 * on-disk one.
 *
 * `stageId` is 45 because the requirement's precedence table has no Stage row: the same
 * section lists its resolution inputs as Project / Workflow Stage / Task Type, which puts
 * Stage between Workflow and Task Type. The gap at 20 belongs to a team axis that the
 * scope input does not carry, so no request can reach it.
 */
export const SCOPE_PRECEDENCE: Readonly<Record<ResolutionAxis, number>> = {
  projectId: 30,
  workflowId: 40,
  stageId: 45,
  taskTypeId: 50,
  roleId: 60,
  providerId: 70,
  runtimeId: 80,
  modelId: 90,
  directory: 100,
};

export const compareScopePrecedence = (left: readonly number[], right: readonly number[]): number => {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftRank = left[index] ?? -1;
    const rightRank = right[index] ?? -1;
    if (leftRank !== rightRank) return leftRank - rightRank;
  }
  return 0;
};

export const compareRank = (left: ResolutionRank, right: ResolutionRank): number => {
  if (left.explicitPriority !== right.explicitPriority) return left.explicitPriority - right.explicitPriority;
  if (left.matchingAxisCount !== right.matchingAxisCount) return left.matchingAxisCount - right.matchingAxisCount;
  const vector = compareScopePrecedence(left.scopePrecedence, right.scopePrecedence);
  if (vector !== 0) return vector;
  if (left.directoryDepth !== right.directoryDepth) return left.directoryDepth - right.directoryDepth;
  return left.sourceLayerPrecedence - right.sourceLayerPrecedence;
};

export const compareDirectoryRank = (left: ResolutionRank, right: ResolutionRank): number => {
  if (left.explicitPriority !== right.explicitPriority) return left.explicitPriority - right.explicitPriority;
  if (left.directoryDepth !== right.directoryDepth) return left.directoryDepth - right.directoryDepth;
  return left.matchingAxisCount - right.matchingAxisCount;
};

export const matchesDirectoryAxis = (rank: ResolutionRank): boolean =>
  // Do not use directoryDepth > 0: a root directory match has depth 0.
  rank.scopePrecedence.includes(SCOPE_PRECEDENCE.directory);

export const beatsCandidate = (left: ResolutionRank, right: ResolutionRank): boolean =>
  matchesDirectoryAxis(left) && matchesDirectoryAxis(right)
    ? compareDirectoryRank(left, right) > 0
    : compareRank(left, right) > 0;

export const selectUnbeaten = <Item extends { readonly rank: ResolutionRank }>(
  items: readonly Item[],
): readonly Item[] =>
  // Do not reduce through partial winners: directory precedence is non-transitive across mixed pairs.
  items.filter((item) => !items.some((other) => other !== item && beatsCandidate(other.rank, item.rank)));

export const selectExclusiveWinner = (candidates: readonly RankedCandidate[]): ExclusiveDecision => {
  const first = candidates[0];
  if (first === undefined) throw new Error("Cannot select an exclusive winner from an empty group.");
  const unbeaten = selectUnbeaten(candidates);
  if (unbeaten.length === 1) return { kind: "winner", candidate: unbeaten[0] as RankedCandidate };
  return {
    kind: "conflict",
    conflict: {
      kind: "exclusive_tie",
      mergeGroup: first.candidate.rule.mergeGroup as string,
      involvedAssetIds: canonicalIds((unbeaten.length === 0 ? candidates : unbeaten).map((candidate) => candidate.candidate.assetId)),
    },
  };
};

export const buildExclusiveGroups = (
  states: CandidateState[],
  addConflict: (conflict: ResolutionConflict) => void,
): Map<string, CandidateState[]> => {
  const exclusiveGroups = new Map<string, CandidateState[]>();
  for (const state of states) {
    if (state.reason.kind !== "included" || state.candidate.rule.mergeMode !== "exclusive") continue;
    const group = exclusiveGroups.get(state.candidate.rule.mergeGroup) ?? [];
    group.push(state);
    exclusiveGroups.set(state.candidate.rule.mergeGroup, group);
  }
  for (const [mergeGroup, group] of exclusiveGroups) {
    // A type contract violation is settled before mandatory adjudication: whether an
    // operation is expressible at all precedes whether an expressible one is allowed.
    const groupTypes = new Set(group.map((state) => state.candidate.assetType));
    if (groupTypes.size > 1) {
      const conflict: ResolutionConflict = {
        kind: "asset_type_conflict",
        involvedAssetIds: canonicalIds(group.map((state) => state.candidate.assetId)),
      };
      addConflict(conflict);
      for (const state of group) state.reason = resolutionConflictReason(conflict, state.rank);
      continue;
    }
    const mandatory = group.filter((state) => state.candidate.rule.mandatory);
    if (mandatory.length > 1) {
      const conflict: ResolutionConflict = {
        kind: "mandatory_conflict",
        involvedAssetIds: canonicalIds(group.map((state) => state.candidate.assetId)),
      };
      addConflict(conflict);
      for (const state of group) state.reason = resolutionConflictReason(conflict, state.rank);
      continue;
    }
    if (mandatory.length === 1) {
      const winner = mandatory[0]!;
      for (const state of group) {
        if (state === winner) continue;
        state.reason = {
          kind: "overridden",
          overriddenBy: winner.candidate.assetId,
          mergeGroup,
          winnerRank: winner.rank!,
        };
      }
      continue;
    }
    // Non-mandatory exclusive selection is derived in the fixed-point loop below.
    // Keeping every matched candidate here allows a dynamic winner to be replaced
    // by a lower-ranked candidate when its availability changes.
  }
  return exclusiveGroups;
};
