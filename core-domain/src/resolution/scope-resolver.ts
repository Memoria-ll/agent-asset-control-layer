import type { AssetResult } from "../failures.ts";
import { codeUnitCompare } from "../ordering.ts";
import type {
  CandidateReason,
  CandidateState,
  OperationPass,
  ResolutionConflict,
  ResolutionResult,
  ResolveScopeInput,
} from "./resolution-types.ts";
import { validateResolutionInput } from "./candidate-validation.ts";
import { matchCandidates } from "./scope-matching.ts";
import { buildIdentityGroups, isSameIdOverlayPair, runCurrentOperation } from "./protection-overlay.ts";
import { buildCapabilityOutcomeByState } from "./dependency-evaluation.ts";
import {
  assembleResult,
  canonicalIds,
  compareCandidatesForOutput,
  conflictKey,
  resolutionConflictReason,
} from "./result-assembly.ts";
import {
  candidateKey,
  currentUnavailableReason,
  dynamicReason,
  selectCurrent,
  type SelectionContext,
} from "./type-resolution.ts";
import { buildExclusiveGroups } from "./ranking-precedence.ts";






/**
 * Resolve operations and requirements as a pure fixed-point calculation.
 *
 * A plan (the issuers whose operations are provisionally applied) is kept
 * separate from derived status.  Each pass derives all operation effects and
 * dependency outcomes from that plan at once; only its canonical signature
 * selects the next pass.  Reasons and aggregate conflicts are materialized
 * after the plan is stable.
 */
const resolveScopeFixedPoint = (
  input: ResolveScopeInput,
): AssetResult<ResolutionResult> => {
  const validated = validateResolutionInput(input);
  if (!validated.ok) return validated;
  const { context, capabilityContext, invalidStates, deduplicated } = validated.value;

  const conflicts = new Map<string, ResolutionConflict>();
  const addConflict = (conflict: ResolutionConflict): void => {
    const canonical: ResolutionConflict = {
      ...conflict,
      involvedAssetIds: canonicalIds(conflict.involvedAssetIds),
    } as ResolutionConflict;
    conflicts.set(conflictKey(canonical), canonical);
  };


  const states = matchCandidates(deduplicated, context);

  const matchedById = buildIdentityGroups(states, addConflict);

  const exclusiveGroups = buildExclusiveGroups(states, addConflict);

  const stateById = new Map<string, CandidateState[]>();
  for (const state of states) {
    const group = stateById.get(String(state.candidate.assetId)) ?? [];
    group.push(state);
    stateById.set(String(state.candidate.assetId), group);
  }
  const invalidById = new Set(invalidStates.map((state) => String(state.candidate.assetId)));
  const staticReasons = new Map(states.map((state) => [state, state.reason] as const));
  const staticIncluded = new Set(states.filter((state) => state.reason.kind === "included"));
  let baseReasons = new Map(staticReasons);
  let baseIncluded = new Set(staticIncluded);
  let operationIssuers: readonly CandidateState[] = [...baseIncluded]
    .filter((state) => state.candidate.rule.operation.kind !== "add")
    .sort(compareCandidatesForOutput);
  let operationIssuerSet = new Set(operationIssuers);
  const selectionExcluded = new Set<CandidateState>();
  const selectionEvidence = new Map<CandidateState, CandidateReason>();
  const unstableExclusiveGroups = new Map<string, ResolutionConflict>();

  const capabilityOutcomeByState = buildCapabilityOutcomeByState({
    baseIncluded,
    capabilityContext,
  });

  let finalSelection = selectCurrent({
    staticReasons,
    staticIncluded,
    selectionEvidence,
    selectionExcluded,
    unstableExclusiveGroups,
    baseIncluded,
    baseReasons,
    invalidById,
    stateById,
  });
  let operationResult: { readonly pass: OperationPass; readonly forcedConflicts: ReadonlyMap<CandidateState, ResolutionConflict> } | undefined;
  const seenSelections = new Set<string>();
  for (;;) {
    finalSelection = selectCurrent({
      staticReasons,
      staticIncluded,
      selectionEvidence,
      selectionExcluded,
      unstableExclusiveGroups,
      baseIncluded,
      baseReasons,
      invalidById,
      stateById,
    });
    for (const conflict of finalSelection.conflicts) {
      if (conflict.kind !== "exclusive_tie") continue;
      for (const state of staticIncluded) {
        if (state.candidate.rule.mergeMode !== "exclusive" || state.candidate.rule.mergeGroup !== conflict.mergeGroup) continue;
        if (!conflict.involvedAssetIds.includes(state.candidate.assetId)) continue;
        selectionEvidence.set(state, resolutionConflictReason(conflict, state.rank));
      }
    }
    const selectionKey = [...selectionExcluded].map(candidateKey).sort(codeUnitCompare).join("\u0001") +
      "\u0002" + [...finalSelection.included].map(candidateKey).sort(codeUnitCompare).join("\u0001");
    if (seenSelections.has(selectionKey)) break;
    seenSelections.add(selectionKey);
    baseReasons = new Map(finalSelection.reasons);
    baseIncluded = new Set(finalSelection.included);
    operationIssuers = finalSelection.operationIssuers;
    operationIssuerSet = new Set(operationIssuers);
    operationResult = runCurrentOperation({
      baseIncluded,
      baseReasons,
      capabilityOutcomeByState,
      invalidById,
      matchedById,
      operationIssuers,
      operationIssuerSet,
      selectionEvidence,
      selectionExcluded,
      stateById,
    });
    let changed = false;
    for (const winner of finalSelection.exclusiveWinners) {
      if (winner.candidate.rule.mergeMode !== "exclusive") {
        throw new Error("Exclusive selection returned a non-exclusive winner.");
      }
      if (winner.candidate.rule.mandatory) continue;
      const evidence = dynamicReason(winner, operationResult.pass);
      if (evidence === undefined) continue;
      // Preserve an operation conflict as evidence even when this is the last
      // selectable candidate.  An exclusive tie is synthesized below only
      // after an earlier exclusion loses support in the current operation graph.
      selectionExcluded.add(winner);
      selectionEvidence.set(winner, evidence);
      changed = true;
    }
    for (const state of selectionExcluded) {
      const evidence = selectionEvidence.get(state);
      if (evidence === undefined || evidence.kind === "excluded") continue;
      const status = operationResult.pass.statuses.get(state);
      let stillSupported: boolean;
      if (evidence.kind === "disabled") stillSupported = status?.kind === "disabled";
      else if (evidence.kind === "overridden") stillSupported = status?.kind === "overridden";
      else if (evidence.kind === "unavailable") {
        const currentEvidence = currentUnavailableReason(state, operationResult.pass, {
          staticReasons,
          staticIncluded,
          selectionEvidence,
          selectionExcluded,
          unstableExclusiveGroups,
          baseIncluded,
          baseReasons,
          invalidById,
          stateById,
        });
        stillSupported = currentEvidence !== undefined;
        if (currentEvidence !== undefined) selectionEvidence.set(state, currentEvidence);
      } else continue;
      if (stillSupported || state.candidate.rule.mergeMode !== "exclusive") continue;
      const mergeGroup = state.candidate.rule.mergeGroup;
      if (unstableExclusiveGroups.has(mergeGroup)) continue;
      const group = [...staticIncluded].filter((candidate) =>
        candidate.candidate.rule.mergeMode === "exclusive" &&
        candidate.candidate.rule.mergeGroup === mergeGroup
      );
      const conflict: ResolutionConflict = {
        kind: "exclusive_tie",
        mergeGroup,
        involvedAssetIds: canonicalIds(group.map((candidate) => candidate.candidate.assetId)),
      };
      unstableExclusiveGroups.set(mergeGroup, conflict);
      for (const candidate of group) selectionEvidence.delete(candidate);
      changed = true;
    }
    if (!changed) break;
  }
  if (operationResult === undefined) throw new Error("Scope operation fixed point was not reached.");
  return assembleResult({
    context,
    states,
    invalidStates,
    conflicts,
    addConflict,
    baseIncluded,
    baseReasons,
    selectionEvidence,
    selectionExcluded,
    finalSelection,
    operationResult,
  });
};

export const resolveScope = (
  input: ResolveScopeInput,
): AssetResult<ResolutionResult> => resolveScopeFixedPoint(input);
