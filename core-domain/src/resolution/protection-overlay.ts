import type { CandidateReason, CandidateState, FixedStatus } from "./resolution-types.ts";
import { sourceLayerPrecedence } from "./ranking-precedence.ts";

export const isSameIdOverlayPair = (
  issuer: CandidateState,
  target: CandidateState,
): boolean => {
  const operation = issuer.candidate.rule.operation;
  return operation.kind !== "add" &&
    operation.targetAssetId === issuer.candidate.assetId &&
    target.candidate.assetId === issuer.candidate.assetId &&
    target.candidate.source.layer !== issuer.candidate.source.layer &&
    sourceLayerPrecedence(target.candidate.source.layer) < sourceLayerPrecedence(issuer.candidate.source.layer);
};

export const hasUnresolvedIdentityPair = (
  group: readonly CandidateState[],
): boolean => group.some((left, leftIndex) =>
  group.slice(leftIndex + 1).some((right) =>
    !isSameIdOverlayPair(left, right) && !isSameIdOverlayPair(right, left)));

export type OperationStatusContext = {
  readonly baseReasons: ReadonlyMap<CandidateState, CandidateReason>;
  readonly selectionEvidence: ReadonlyMap<CandidateState, CandidateReason>;
};

export const statusForState = (
  state: CandidateState,
  statuses: ReadonlyMap<CandidateState, FixedStatus>,
  ctx: OperationStatusContext,
): FixedStatus | undefined => {
    const { baseReasons, selectionEvidence } = ctx;
    // A target can be selected by a surviving issuer after its own selection
    // was excluded.  The operation status describes the current graph and
    // must supersede stale selection evidence for dependency classification.
    const currentStatus = statuses.get(state);
    if (currentStatus !== undefined) return currentStatus;
    const evidence = selectionEvidence.get(state);
    if (evidence?.kind === "disabled") return { kind: "disabled", disabledBy: evidence.disabledBy };
    if (evidence?.kind === "overridden") {
      return {
        kind: "overridden",
        overriddenBy: evidence.overriddenBy,
        mergeGroup: evidence.mergeGroup,
        winnerRank: evidence.winnerRank,
      };
    }
    if (evidence?.kind === "excluded" && evidence.cause === "resolution_conflict") {
      return { kind: "conflict", conflict: evidence.conflict };
    }
    const reason = baseReasons.get(state);
    if (reason?.kind === "disabled") return { kind: "disabled", disabledBy: reason.disabledBy };
    if (reason?.kind === "overridden") {
      return {
        kind: "overridden",
        overriddenBy: reason.overriddenBy,
        mergeGroup: reason.mergeGroup,
        winnerRank: reason.winnerRank,
      };
    }
    if (reason?.kind === "excluded" && reason.cause === "resolution_conflict") {
      return { kind: "conflict", conflict: reason.conflict };
    }
    return undefined;
  };
