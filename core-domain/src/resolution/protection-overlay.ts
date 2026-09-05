import type { AssetId } from "@aacl/shared";
import { codeUnitCompare } from "../ordering.ts";
import type { CapabilityDependencyOutcome } from "../capabilities/dependencies.ts";
import { dependencyOutcomes } from "./dependency-evaluation.ts";
import type {
  CandidateReason,
  CandidateState,
  FixedStatus,
  OperationAction,
  OperationConflictEntry,
  OperationCycle,
  OperationFailure,
  OperationPass,
  ResolutionConflict,
} from "./resolution-types.ts";
import { stronglyConnectedComponents } from "./graph.ts";
import { sourceLayerPrecedence, selectUnbeaten } from "./ranking-precedence.ts";
import { canonicalIds, compareCandidatesForOutput, resolutionConflictReason } from "./result-assembly.ts";

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

export const buildIdentityGroups = (
  states: CandidateState[],
  addConflict: (conflict: ResolutionConflict) => void,
): Map<string, CandidateState[]> => {
  // Identity overlays are the only same-ID pair that is allowed to remain
  // together.  The exemption is pairwise: an unrelated candidate keeps the
  // entire identity group in duplicate conflict.
  const matchedById = new Map<string, CandidateState[]>();
  for (const state of states) {
    if (!state.matched) continue;
    const group = matchedById.get(String(state.candidate.assetId)) ?? [];
    group.push(state);
    matchedById.set(String(state.candidate.assetId), group);
  }
  for (const group of matchedById.values()) {
    if (group.length < 2 || !hasUnresolvedIdentityPair(group)) continue;
    const conflict: ResolutionConflict = {
      kind: "duplicate_identity",
      assetId: group[0]!.candidate.assetId,
      involvedAssetIds: canonicalIds(group.map((state) => state.candidate.assetId)),
    };
    addConflict(conflict);
    for (const state of group) state.reason = resolutionConflictReason(conflict, state.rank);
  }
  return matchedById;
};

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
        ...(evidence.mergeGroup === undefined ? {} : { mergeGroup: evidence.mergeGroup }),
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
        ...(reason.mergeGroup === undefined ? {} : { mergeGroup: reason.mergeGroup }),
        winnerRank: reason.winnerRank,
      };
    }
    if (reason?.kind === "excluded" && reason.cause === "resolution_conflict") {
      return { kind: "conflict", conflict: reason.conflict };
    }
    return undefined;
  };

export type OverlayEvaluationContext = {
  readonly baseIncluded: ReadonlySet<CandidateState>;
  readonly baseReasons: ReadonlyMap<CandidateState, CandidateReason>;
  readonly capabilityOutcomeByState: ReadonlyMap<CandidateState, CapabilityDependencyOutcome>;
  readonly invalidById: ReadonlySet<string>;
  readonly matchedById: ReadonlyMap<string, CandidateState[]>;
  readonly operationIssuers: readonly CandidateState[];
  readonly operationIssuerSet: ReadonlySet<CandidateState>;
  readonly selectionEvidence: ReadonlyMap<CandidateState, CandidateReason>;
  readonly selectionExcluded: ReadonlySet<CandidateState>;
  readonly stateById: ReadonlyMap<string, CandidateState[]>;
};

const makeOperationConflict = (targetAssetId: AssetId, involvedAssetIds: readonly AssetId[]): ResolutionConflict => ({
    kind: "operation_conflict",
    targetAssetId,
    involvedAssetIds: canonicalIds(involvedAssetIds),
  });

export const evaluatePlan = (
  plan: ReadonlySet<CandidateState>,
  forcedConflicts: ReadonlyMap<CandidateState, ResolutionConflict>,
  ctx: OverlayEvaluationContext,
): OperationPass => {
  const { baseIncluded, baseReasons, capabilityOutcomeByState, invalidById, matchedById,
          operationIssuers, operationIssuerSet, selectionEvidence, selectionExcluded, stateById } = ctx;
    const operationActions: OperationAction[] = [];
    const failures: OperationFailure[] = [];
    const operationConflicts: OperationConflictEntry[] = [];
    const conflictByIssuer = new Map<CandidateState, ResolutionConflict>();
    const matchedTargetsFor = (issuer: CandidateState, targetAssetId: AssetId): CandidateState[] =>
      (matchedById.get(String(targetAssetId)) ?? []).filter((state) => state !== issuer);
    const actionableTargetsFor = (
      issuer: CandidateState,
      targetAssetId: AssetId,
      matchedTargets: readonly CandidateState[],
    ): CandidateState[] => {
      const candidates = matchedTargets.filter((state) => {
        if (baseIncluded.has(state)) return true;
        const selectionReason = selectionEvidence.get(state);
        if (
          selectionExcluded.has(state) &&
          selectionReason !== undefined &&
          (!(selectionReason.kind === "excluded" && selectionReason.cause === "resolution_conflict") ||
            (issuer.candidate.rule.mergeMode === "exclusive" &&
              state.candidate.rule.mergeMode === "exclusive" &&
              issuer.candidate.rule.mergeGroup === state.candidate.rule.mergeGroup))
        ) return true;
        const reason = baseReasons.get(state);
        return reason?.kind === "overridden" && reason.overriddenBy === issuer.candidate.assetId;
      });
      if (targetAssetId === issuer.candidate.assetId) {
        return candidates.filter((state) => isSameIdOverlayPair(issuer, state));
      }
      return candidates;
    };
    for (const issuer of operationIssuers) {
      if (!plan.has(issuer) || forcedConflicts.has(issuer)) continue;
      const operation = issuer.candidate.rule.operation;
      if (operation.kind === "add") continue;
      const matchedTargets = matchedTargetsFor(issuer, operation.targetAssetId);
      // Expressibility is read off every matched candidate carrying the target id,
      // before eligibility narrows them: a candidate that lost an exclusive merge or
      // was excluded elsewhere is no longer actionable, while the cross-type relation
      // it stands in remains one.  Same ordering reason as the exclusive group check —
      // a relation that is not expressible is settled ahead of every rule that
      // presumes an expressible one, the direct requirement below and mandatory
      // protection alike.
      if (matchedTargets.some((target) => target.candidate.assetType !== issuer.candidate.assetType)) {
        failures.push({
          issuer,
          conflict: {
            kind: "asset_type_conflict",
            involvedAssetIds: canonicalIds([
              issuer.candidate.assetId,
              ...matchedTargets.map((target) => target.candidate.assetId),
            ]),
          },
        });
        continue;
      }
      // A direct requirement is authoritative over a disable/override of the
      // same target: applying that action would invalidate its issuer.  The
      // candidate remains available, while the action is simply inapplicable.
      if (issuer.candidate.rule.requires.includes(operation.targetAssetId)) continue;
      const targets = actionableTargetsFor(issuer, operation.targetAssetId, matchedTargets);
      if (targets.length === 0 || (operation.targetAssetId !== issuer.candidate.assetId && targets.length !== 1)) {
        failures.push({
          issuer,
          conflict: makeOperationConflict(operation.targetAssetId, [issuer.candidate.assetId, operation.targetAssetId]),
        });
        continue;
      }
      if (targets.some((target) => target.candidate.rule.mandatory)) {
        failures.push({
          issuer,
          conflict: {
            kind: "mandatory_conflict",
            involvedAssetIds: canonicalIds([issuer.candidate.assetId, ...targets.map((target) => target.candidate.assetId)]),
          },
        });
        continue;
      }
      // A shared merge group is what makes a cross-ID override expressible: it is the
      // only declaration saying the two candidates are alternatives rather than
      // unrelated assets.  A same-ID overlay carries that relation in the identity
      // itself, so requiring a group there would restrict overrides to assets whose
      // author happened to declare one — the additive default could never be overridden.
      if (operation.kind === "override" && operation.targetAssetId !== issuer.candidate.assetId && (
        issuer.candidate.rule.mergeGroup === undefined ||
        targets.some((target) => target.candidate.rule.mergeGroup === undefined || issuer.candidate.rule.mergeGroup !== target.candidate.rule.mergeGroup)
      )) {
        failures.push({
          issuer,
          conflict: makeOperationConflict(operation.targetAssetId, [issuer.candidate.assetId, operation.targetAssetId]),
        });
        continue;
      }
      for (const target of targets) operationActions.push({ issuer, target, kind: operation.kind });
    }

    const actionsByTarget = new Map<CandidateState, OperationAction[]>();
    for (const action of operationActions) {
      const actions = actionsByTarget.get(action.target) ?? [];
      actions.push(action);
      actionsByTarget.set(action.target, actions);
    }
    const selectedActions: OperationAction[] = [];
    const chosenByTarget = new Map<CandidateState, OperationAction>();
    const addIssuerConflict = (issuer: CandidateState, conflict: ResolutionConflict): void => {
      if (!conflictByIssuer.has(issuer)) conflictByIssuer.set(issuer, conflict);
    };
    for (const target of [...actionsByTarget.keys()].sort(compareCandidatesForOutput)) {
      const actions = actionsByTarget.get(target)!.slice().sort((left, right) => {
        const issuerOrder = compareCandidatesForOutput(left.issuer, right.issuer);
        if (issuerOrder !== 0) return issuerOrder;
        return codeUnitCompare(left.kind, right.kind);
      });
      const best = selectUnbeaten(actions.map((action) => ({ action, rank: action.issuer.rank! }))).map(({ action }) => action);
      // A precedence cycle leaves no unbeaten action, but issuers that all disable are not
      // contradictory: coalesce them on output order rather than leaving the target enabled.
      const contenders = best.length === 0 ? actions : best;
      const allDisable = contenders.every((action) => action.kind === "disable");
      if (contenders.length > 1 && !allDisable) {
        const conflict = makeOperationConflict(target.candidate.assetId, [target.candidate.assetId, ...actions.map((action) => action.issuer.candidate.assetId)]);
        operationConflicts.push({ conflict, issuers: actions.map((action) => action.issuer) });
        for (const action of actions) addIssuerConflict(action.issuer, conflict);
        continue;
      }
      const winner = allDisable
        ? contenders.slice().sort((left, right) => compareCandidatesForOutput(left.issuer, right.issuer))[0]!
        : contenders[0]!;
      selectedActions.push(winner);
      chosenByTarget.set(target, winner);
      for (const action of actions) {
        if (action === winner || action.kind === winner.kind) continue;
        const conflict = makeOperationConflict(target.candidate.assetId, [target.candidate.assetId, action.issuer.candidate.assetId, winner.issuer.candidate.assetId]);
        operationConflicts.push({ conflict, issuers: [action.issuer, winner.issuer] });
        addIssuerConflict(action.issuer, conflict);
      }
    }

    const statuses = new Map<CandidateState, FixedStatus>();
    for (const state of baseIncluded) statuses.set(state, { kind: "included" });
    for (const [issuer, conflict] of forcedConflicts) statuses.set(issuer, { kind: "conflict", conflict });
    for (const [issuer, conflict] of conflictByIssuer) {
      if (!statuses.has(issuer) || statuses.get(issuer)?.kind === "included") statuses.set(issuer, { kind: "conflict", conflict });
    }
    for (const failure of failures) {
      if (statuses.get(failure.issuer)?.kind === "included") statuses.set(failure.issuer, { kind: "conflict", conflict: failure.conflict });
    }
    for (const action of selectedActions) {
      statuses.set(action.target, action.kind === "disable"
        ? { kind: "disabled", disabledBy: action.issuer.candidate.assetId }
        : {
            kind: "overridden",
            overriddenBy: action.issuer.candidate.assetId,
            ...(action.issuer.candidate.rule.mergeGroup === undefined
              ? {}
              : { mergeGroup: action.issuer.candidate.rule.mergeGroup }),
            winnerRank: action.issuer.rank!,
          });
    }

    const dependency = dependencyOutcomes(statuses, {
      baseIncluded,
      baseReasons,
      selectionEvidence,
      capabilityOutcomeByState,
      invalidById,
      stateById,
    });
    const actionGraphActions = selectedActions.filter((action) => dependency.get(action.issuer)?.ok === true);
    const actionOutgoing = new Map<CandidateState, CandidateState[]>();
    const actionNodes = new Set<CandidateState>();
    for (const action of actionGraphActions) {
      const targets = actionOutgoing.get(action.issuer) ?? [];
      targets.push(action.target);
      actionOutgoing.set(action.issuer, targets);
      actionNodes.add(action.issuer);
      actionNodes.add(action.target);
    }
    const actionComponents = stronglyConnectedComponents([...actionNodes], actionOutgoing, compareCandidatesForOutput);
    const actionComponentByNode = new Map<CandidateState, number>();
    actionComponents.forEach((component, index) => {
      for (const node of component) actionComponentByNode.set(node, index);
    });
    const actionsByComponent = new Map<number, OperationAction[]>();
    for (const action of actionGraphActions) {
      const issuerComponent = actionComponentByNode.get(action.issuer);
      const targetComponent = actionComponentByNode.get(action.target);
      if (issuerComponent === undefined || issuerComponent !== targetComponent) continue;
      const componentActions = actionsByComponent.get(issuerComponent) ?? [];
      componentActions.push(action);
      actionsByComponent.set(issuerComponent, componentActions);
    }
    const cycles: OperationCycle[] = [];
    for (let componentIndex = 0; componentIndex < actionComponents.length; componentIndex += 1) {
      const component = actionComponents[componentIndex]!;
      const componentActions = actionsByComponent.get(componentIndex) ?? [];
      const hasCycle = component.length > 1 || componentActions.some((action) => action.issuer === action.target);
      if (!hasCycle) continue;
      const ids = canonicalIds(component.map((state) => state.candidate.assetId));
      cycles.push({
        conflict: makeOperationConflict(ids[0]!, ids),
        issuers: component.filter((state) => operationIssuerSet.has(state)),
      });
    }

    const nextPlan = new Set<CandidateState>();
    for (const issuer of operationIssuers) {
      if (forcedConflicts.has(issuer)) continue;
      const status = statuses.get(issuer);
      if (status?.kind === "included" && dependency.get(issuer)?.ok === true) nextPlan.add(issuer);
    }
    return {
      statuses,
      dependency,
      selectedActions,
      operationConflicts,
      failures,
      cycles,
      nextPlan,
    };
  };

  const planKey = (plan: ReadonlySet<CandidateState>): string =>
    [...plan].sort(compareCandidatesForOutput).map((state) => `${state.candidate.assetId}\u0000${state.candidate.source.layer}\u0000${state.candidate.source.sourceId}`).join("\u0001");
  const samePlan = (left: ReadonlySet<CandidateState>, right: ReadonlySet<CandidateState>): boolean =>
    left.size === right.size && [...left].every((state) => right.has(state));

export const runCurrentOperation = (ctx: OverlayEvaluationContext): {
  readonly pass: OperationPass;
  readonly forcedConflicts: ReadonlyMap<CandidateState, ResolutionConflict>;
} => {
  const { operationIssuers, operationIssuerSet } = ctx;
    const forcedConflicts = new Map<CandidateState, ResolutionConflict>();
    const operationConflictCandidates = (pass: OperationPass): ReadonlyMap<CandidateState, ResolutionConflict> => {
      const candidates = new Map<CandidateState, ResolutionConflict>();
      for (const entry of pass.operationConflicts) {
        for (const issuer of entry.issuers) {
          if (pass.statuses.get(issuer)?.kind === "conflict" && pass.dependency.get(issuer)?.ok === true) {
            candidates.set(issuer, entry.conflict);
          }
        }
      }
      for (const failure of pass.failures) {
        if (pass.statuses.get(failure.issuer)?.kind === "conflict" && pass.dependency.get(failure.issuer)?.ok === true) {
          candidates.set(failure.issuer, failure.conflict);
        }
      }
      return candidates;
    };
    const tryStablePlanAfterExcluding = (
      excluded: CandidateState,
    ): { readonly plan: ReadonlySet<CandidateState>; readonly pass: OperationPass } | undefined => {
      let trialPlan = new Set(operationIssuers.filter((issuer) => issuer !== excluded && !forcedConflicts.has(issuer)));
      const trialSeen = new Set<string>();
      for (;;) {
        const key = planKey(trialPlan);
        if (trialSeen.has(key)) return undefined;
        trialSeen.add(key);
        const trialPass = evaluatePlan(trialPlan, forcedConflicts, ctx);
        if (trialPass.cycles.length > 0 || operationConflictCandidates(trialPass).size > 0) return undefined;
        if (samePlan(trialPass.nextPlan, trialPlan)) return { plan: trialPlan, pass: trialPass };
        trialPlan = new Set(trialPass.nextPlan);
      }
    };
    const tryAcyclicNoRequirementPlan = (): { readonly plan: ReadonlySet<CandidateState>; readonly pass: OperationPass } | undefined => {
      if (operationIssuers.some((issuer) => issuer.candidate.rule.requires.length > 0)) return undefined;
      const allPass = evaluatePlan(new Set(operationIssuers), forcedConflicts, ctx);
      if (allPass.cycles.length > 0 || allPass.operationConflicts.length > 0 || allPass.failures.length > 0) return undefined;
      // Availability is part of operation graph discovery.  An issuer whose
      // dependency closure failed cannot participate in either a cycle or the
      // topological blocking pass, even when its provisional action was selected.
      const eligibleActions = allPass.selectedActions.filter((action) => allPass.dependency.get(action.issuer)?.ok === true);

      const actionCountByIssuer = new Map<CandidateState, number>();
      const actionCountByTargetId = new Map<string, number>();
      for (const action of eligibleActions) {
        actionCountByIssuer.set(action.issuer, (actionCountByIssuer.get(action.issuer) ?? 0) + 1);
        const targetId = String(action.target.candidate.assetId);
        actionCountByTargetId.set(targetId, (actionCountByTargetId.get(targetId) ?? 0) + 1);
      }
      if ([...actionCountByIssuer.values()].some((count) => count !== 1) || [...actionCountByTargetId.values()].some((count) => count !== 1)) {
        return undefined;
      }

      const outgoing = new Map<CandidateState, CandidateState[]>();
      for (const issuer of operationIssuers) outgoing.set(issuer, []);
      for (const action of eligibleActions) {
        if (!operationIssuerSet.has(action.target)) continue;
        outgoing.get(action.issuer)!.push(action.target);
      }
      const components = stronglyConnectedComponents(operationIssuers, outgoing, compareCandidatesForOutput);
      if (components.some((component) => component.length > 1 || (outgoing.get(component[0]!) ?? []).includes(component[0]!))) return undefined;

      const remainingIncoming = new Map<CandidateState, number>();
      for (const issuer of operationIssuers) remainingIncoming.set(issuer, 0);
      for (const targets of outgoing.values()) for (const target of targets) remainingIncoming.set(target, remainingIncoming.get(target)! + 1);
      const ready: CandidateState[] = [];
      const less = (left: CandidateState, right: CandidateState): boolean => compareCandidatesForOutput(left, right) < 0;
      const pushReady = (value: CandidateState): void => {
        ready.push(value);
        let index = ready.length - 1;
        while (index > 0) {
          const parent = Math.floor((index - 1) / 2);
          if (!less(value, ready[parent]!)) break;
          ready[index] = ready[parent]!;
          index = parent;
        }
        ready[index] = value;
      };
      const popReady = (): CandidateState | undefined => {
        const first = ready[0];
        const last = ready.pop();
        if (first === undefined) return undefined;
        if (last !== undefined && ready.length > 0) {
          let index = 0;
          while (true) {
            const left = index * 2 + 1;
            if (left >= ready.length) break;
            const right = left + 1;
            const child = right < ready.length && less(ready[right]!, ready[left]!) ? right : left;
            if (!less(ready[child]!, last)) break;
            ready[index] = ready[child]!;
            index = child;
          }
          ready[index] = last;
        }
        return first;
      };
      for (const issuer of operationIssuers) if (remainingIncoming.get(issuer) === 0) pushReady(issuer);
      const active = new Set<CandidateState>();
      const blocked = new Set<CandidateState>();
      let processed = 0;
      for (;;) {
        const issuer = popReady();
        if (issuer === undefined) break;
        processed += 1;
        if (!blocked.has(issuer)) {
          active.add(issuer);
          for (const target of outgoing.get(issuer) ?? []) blocked.add(target);
        }
        for (const target of outgoing.get(issuer) ?? []) {
          const incoming = remainingIncoming.get(target)! - 1;
          remainingIncoming.set(target, incoming);
          if (incoming === 0) pushReady(target);
        }
      }
      if (processed !== operationIssuers.length) return undefined;
      const pass = evaluatePlan(active, forcedConflicts, ctx);
      if (pass.cycles.length > 0 || operationConflictCandidates(pass).size > 0 || !samePlan(pass.nextPlan, active)) return undefined;
      return { plan: active, pass };
    };

    let finalPass: OperationPass | undefined = tryAcyclicNoRequirementPlan()?.pass;
    if (finalPass === undefined) {
      let plan = new Set(operationIssuers);
      const seenPlans = new Map<string, OperationPass>();
      for (;;) {
        const currentKey = planKey(plan);
        const pass = evaluatePlan(plan, forcedConflicts, ctx);
        if (pass.cycles.length > 0) {
          for (const cycle of pass.cycles) for (const issuer of cycle.issuers) forcedConflicts.set(issuer, cycle.conflict);
          plan = new Set(operationIssuers.filter((issuer) => !forcedConflicts.has(issuer)));
          seenPlans.clear();
          continue;
        }

        // Operation validation/group conflicts are stable exclusions.  Pin them
        // before another pass so a failed operation cannot change category after
        // its target state changes.
        const operationConflictSet = operationConflictCandidates(pass);
        if (operationConflictSet.size > 0) {
          for (const [issuer, conflict] of operationConflictSet) forcedConflicts.set(issuer, conflict);
          plan = new Set(operationIssuers.filter((issuer) => !forcedConflicts.has(issuer)));
          seenPlans.clear();
          continue;
        }
        const nextKey = planKey(pass.nextPlan);
        const priorPass = seenPlans.get(nextKey);
        if (samePlan(pass.nextPlan, plan)) {
          finalPass = pass;
          break;
        }
        if (priorPass !== undefined) {
          // A dependency/operation feedback loop has no canonical traversal order.
          // First try each failing issuer as a pure exclusion; retain a conflict
          // only when no exclusion reaches a stable plan.
          const feedbackIssuers = operationIssuers.filter((issuer) =>
            (pass.statuses.get(issuer)?.kind === "included" && pass.dependency.get(issuer)?.ok === false) ||
            (priorPass.statuses.get(issuer)?.kind === "included" && priorPass.dependency.get(issuer)?.ok === false) ||
            pass.failures.some((failure) => failure.issuer === issuer) ||
            priorPass.failures.some((failure) => failure.issuer === issuer),
          ).sort(compareCandidatesForOutput);
          const stableTrial = feedbackIssuers
            .map((issuer) => tryStablePlanAfterExcluding(issuer))
            .find((trial): trial is { readonly plan: ReadonlySet<CandidateState>; readonly pass: OperationPass } => trial !== undefined);
          if (stableTrial !== undefined) {
            plan = new Set(stableTrial.plan);
            seenPlans.clear();
            continue;
          }
          const fallback = feedbackIssuers.length > 0
            ? feedbackIssuers
            : operationIssuers.filter((issuer) => !forcedConflicts.has(issuer)).slice(-1);
          for (const issuer of fallback) {
            const operation = issuer.candidate.rule.operation;
            if (operation.kind === "add") continue;
            const failure = [...pass.failures, ...priorPass.failures].find((item) => item.issuer === issuer);
            forcedConflicts.set(issuer, failure?.conflict ?? makeOperationConflict(operation.targetAssetId, [issuer.candidate.assetId, operation.targetAssetId]));
          }
          if (fallback.length === 0) {
            finalPass = pass;
            break;
          }
          plan = new Set(operationIssuers.filter((issuer) => !forcedConflicts.has(issuer)));
          seenPlans.clear();
          continue;
        }
        seenPlans.set(currentKey, pass);
        plan = new Set(pass.nextPlan);
      }
    }
    if (finalPass === undefined) throw new Error("Scope operation fixed point was not reached.");
    return { pass: finalPass, forcedConflicts };
  };
