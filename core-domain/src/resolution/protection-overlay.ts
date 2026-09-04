import type { CandidateState } from "./resolution-types.ts";
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
