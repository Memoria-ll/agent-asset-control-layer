import { RESOLUTION_AXES, type ResolutionAxis, type ResolutionContext } from "./resolution-context.ts";
import type { CandidateState, NormalizedCandidate, ScopeMatchDecision } from "./resolution-types.ts";
import { SCOPE_PRECEDENCE, sourceLayerPrecedence } from "./ranking-precedence.ts";

const directorySegments = (value: string): readonly string[] => value === "/" ? [] : value.slice(1).split("/");

const directoryMatches = (
  candidateSegments: readonly string[],
  requestSegments: readonly string[],
): boolean =>
  candidateSegments.length <= requestSegments.length &&
  candidateSegments.every((segment, index) => segment === requestSegments[index]);

export const matchesScope = (
  candidate: NormalizedCandidate,
  context: ResolutionContext,
): ScopeMatchDecision => {
  const mismatchedAxes: ResolutionAxis[] = [];
  const matchedAxes: ResolutionAxis[] = [];
  let directoryDepth = 0;

  for (const axis of RESOLUTION_AXES) {
    const requestValue = context[axis];
    if (requestValue === undefined) continue;
    const selectors = candidate.candidate.rule.selectors[axis];
    if (selectors === undefined) continue;

    if (axis === "directory") {
      const requestSegments = directorySegments(requestValue);
      const matchedSelector = selectors
        .map(directorySegments)
        .filter((segments) => directoryMatches(segments, requestSegments))
        .sort((left, right) => right.length - left.length)[0];
      if (matchedSelector === undefined) mismatchedAxes.push(axis);
      else {
        matchedAxes.push(axis);
        directoryDepth = matchedSelector.length;
      }
      continue;
    }

    if (!selectors.includes(requestValue)) mismatchedAxes.push(axis);
    else {
      matchedAxes.push(axis);
    }
  }

  if (mismatchedAxes.length > 0) return { matched: false, mismatchedAxes };
  return {
    matched: true,
    matchedAxes,
    rank: {
      explicitPriority: candidate.candidate.rule.explicitPriority ?? -1,
      matchingAxisCount: matchedAxes.length,
      scopePrecedence: matchedAxes.map((axis) => SCOPE_PRECEDENCE[axis]).sort((left, right) => right - left),
      directoryDepth,
      sourceLayerPrecedence: sourceLayerPrecedence(candidate.candidate.source.layer),
    },
  };
};

export const matchCandidates = (
  deduplicated: readonly NormalizedCandidate[],
  context: ResolutionContext,
): CandidateState[] => {
  const states: CandidateState[] = deduplicated.map((normalized) => ({
    candidate: normalized.candidate,
    matched: false,
    reason: { kind: "excluded", cause: "scope_mismatch", mismatchedAxes: [] },
  }));

  for (const state of states) {
    const decision = matchesScope({ candidate: state.candidate }, context);
    if (decision.matched) {
      state.matched = true;
      state.rank = decision.rank;
      state.reason = { kind: "included", matchedAxes: decision.matchedAxes, rank: decision.rank };
    } else {
      state.reason = { kind: "excluded", cause: "scope_mismatch", mismatchedAxes: decision.mismatchedAxes };
    }
  }
  return states;
};
