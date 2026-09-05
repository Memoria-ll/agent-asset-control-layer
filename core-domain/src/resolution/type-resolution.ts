import type { AssetId } from "@aacl/shared";
import { codeUnitCompare } from "../ordering.ts";
import { statusForState } from "./protection-overlay.ts";
import { selectExclusiveWinner } from "./ranking-precedence.ts";
import {
  canonicalIds,
  compareCandidatesForOutput,
  resolutionConflictReason,
} from "./result-assembly.ts";
import type {
  CandidateReason,
  CandidateState,
  DependencyCause,
  OperationPass,
  ResolutionConflict,
  SelectionPass,
} from "./resolution-types.ts";

export type SelectionContext = {
  readonly staticReasons: ReadonlyMap<CandidateState, CandidateReason>;
  readonly staticIncluded: ReadonlySet<CandidateState>;
  readonly selectionEvidence: Map<CandidateState, CandidateReason>;
  readonly selectionExcluded: Set<CandidateState>;
  readonly unstableExclusiveGroups: Map<string, ResolutionConflict>;
  readonly baseIncluded: ReadonlySet<CandidateState>;
  readonly baseReasons: ReadonlyMap<CandidateState, CandidateReason>;
  readonly invalidById: ReadonlySet<string>;
  readonly stateById: ReadonlyMap<string, CandidateState[]>;
};

export const candidateKey = (state: CandidateState): string =>
    `${String(state.candidate.assetId)}\u0000${String(state.candidate.revision)}\u0000${state.candidate.source.layer}\u0000${state.candidate.source.sourceId}`;
export const selectCurrent = (ctx: SelectionContext): SelectionPass => {
  const { staticReasons, staticIncluded, selectionEvidence, selectionExcluded, unstableExclusiveGroups } = ctx;
    const reasons = new Map(staticReasons);
    const included = new Set<CandidateState>(
      [...staticIncluded].filter((state) => !selectionExcluded.has(state)),
    );
    const exclusiveWinners: CandidateState[] = [];
    const selectionConflicts: ResolutionConflict[] = [];
    const groups = new Map<string, CandidateState[]>();
    for (const state of staticIncluded) {
      if (state.candidate.rule.mergeMode !== "exclusive") continue;
      const group = groups.get(state.candidate.rule.mergeGroup) ?? [];
      group.push(state);
      groups.set(state.candidate.rule.mergeGroup, group);
    }
    for (const [mergeGroup, group] of groups) {
      const unstableConflict = unstableExclusiveGroups.get(mergeGroup);
      if (unstableConflict !== undefined) {
        selectionConflicts.push(unstableConflict);
        for (const state of group) {
          included.delete(state);
          reasons.set(state, resolutionConflictReason(unstableConflict, state.rank));
        }
        continue;
      }
      const candidates = group.filter((state) => !selectionExcluded.has(state));
      const mandatory = candidates.filter((state) => state.candidate.rule.mandatory);
      if (mandatory.length > 0) {
        const winner = mandatory[0]!;
        exclusiveWinners.push(winner);
        included.add(winner);
        for (const state of candidates) {
          if (state === winner) continue;
          included.delete(state);
          reasons.set(state, {
            kind: "overridden",
            overriddenBy: winner.candidate.assetId,
            mergeGroup,
            winnerRank: winner.rank!,
          });
        }
        continue;
      }
      if (candidates.length === 0) {
        const groupIds = new Set(group.map((state) => String(state.candidate.assetId)));
        const dependencyFeedback = group.every((state) => {
          const evidence = selectionEvidence.get(state);
          // A tie represents a selection cycle only when every failure is
          // peer-related.  Independent failures keep the candidates
          // unavailable even if a peer requirement also failed.
          return evidence?.kind === "unavailable" &&
            evidence.failedRequirements.length > 0 &&
            evidence.failedRequirements.every((requiredId) => groupIds.has(String(requiredId)));
        });
        if (dependencyFeedback) {
          const conflict: ResolutionConflict = {
            kind: "exclusive_tie",
            mergeGroup,
            involvedAssetIds: canonicalIds(group.map((state) => state.candidate.assetId)),
          };
          selectionConflicts.push(conflict);
          for (const state of group) reasons.set(state, resolutionConflictReason(conflict, state.rank));
        }
        continue;
      }
      const decision = selectExclusiveWinner(candidates.map((state) => ({
        candidate: state.candidate,
        rank: state.rank!,
      })));
      if (decision.kind === "conflict") {
        selectionConflicts.push(decision.conflict);
        for (const state of candidates) {
          included.delete(state);
          reasons.set(state, resolutionConflictReason(decision.conflict, state.rank));
        }
        continue;
      }
      const winner = candidates.find((state) => state.candidate === decision.candidate.candidate);
      if (winner === undefined) throw new Error("Exclusive selection returned an unknown candidate.");
      exclusiveWinners.push(winner);
      included.add(winner);
      for (const state of candidates) {
        if (state === winner) continue;
        included.delete(state);
        reasons.set(state, {
          kind: "overridden",
          overriddenBy: winner.candidate.assetId,
          mergeGroup,
          winnerRank: winner.rank!,
        });
      }
    }
    const currentOperationIssuers = [...included]
      .filter((state) => state.candidate.rule.operation.kind !== "add")
      .sort(compareCandidatesForOutput);
    return {
      included,
      reasons,
      operationIssuers: currentOperationIssuers,
      exclusiveWinners,
      conflicts: selectionConflicts,
    };
  };
export const dynamicReason = (state: CandidateState, pass: OperationPass): CandidateReason | undefined => {
    const status = pass.statuses.get(state);
    if (status?.kind === "disabled") return { kind: "disabled", disabledBy: status.disabledBy };
    if (status?.kind === "overridden") return {
      kind: "overridden",
      overriddenBy: status.overriddenBy,
      ...(status.mergeGroup === undefined ? {} : { mergeGroup: status.mergeGroup }),
      winnerRank: status.winnerRank,
    };
    if (status?.kind === "conflict") return resolutionConflictReason(status.conflict, state.rank);
    const outcome = pass.dependency.get(state);
    if (outcome !== undefined && !outcome.ok) return {
      kind: "unavailable",
      availability: "unavailable",
      cause: outcome.cause,
      failedRequirements: [...outcome.failedRequirements],
    };
    return undefined;
  };
export const currentUnavailableReason = (
  state: CandidateState,
  pass: OperationPass,
  ctx: SelectionContext,
): CandidateReason | undefined => {
  const { baseIncluded, baseReasons, invalidById, selectionEvidence, stateById } = ctx;
    const failures: { readonly id: AssetId; readonly cause: DependencyCause }[] = [];
    for (const requiredId of state.candidate.rule.requires) {
      const activeTargets = [...baseIncluded].filter((candidate) =>
        candidate.candidate.assetId === requiredId &&
        pass.statuses.get(candidate)?.kind === "included"
      );
      if (activeTargets.length === 1) {
        const outcome = pass.dependency.get(activeTargets[0]!);
        if (outcome !== undefined && !outcome.ok) failures.push({ id: requiredId, cause: outcome.cause });
        continue;
      }
      const candidatesForId = stateById.get(String(requiredId)) ?? [];
      const matchedCandidates = candidatesForId.filter((candidate) => candidate.matched);
      let cause: DependencyCause;
      if (activeTargets.length > 1) cause = "requirement_invalid";
      else if (matchedCandidates.length > 0) {
        const kinds = matchedCandidates.map((candidate) => statusForState(candidate, pass.statuses, {
          baseReasons,
          selectionEvidence,
        })?.kind);
        if (kinds.every((kind) => kind === "disabled")) cause = "requirement_disabled";
        else if (kinds.every((kind) => kind === "overridden")) cause = "requirement_overridden";
        else cause = "requirement_invalid";
      } else if (invalidById.has(String(requiredId))) cause = "requirement_invalid";
      else if (candidatesForId.length === 0) cause = "missing_requirement";
      else cause = "requirement_out_of_scope";
      failures.push({ id: requiredId, cause });
    }
    failures.sort((left, right) => codeUnitCompare(left.id, right.id));
    if (failures.length === 0) return undefined;
    return {
      kind: "unavailable",
      availability: "unavailable",
      cause: failures[0]!.cause,
      failedRequirements: failures.map((failure) => failure.id),
    };
  };
