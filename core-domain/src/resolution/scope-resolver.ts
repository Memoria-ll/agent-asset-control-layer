import type {
  AssetId,
  AssetType,
  CoreErrorDetail,
  LoadingTier,
} from "@aacl/shared";
import { DEFAULT_ASSET_TYPE_CONTRACTS } from "./asset-type-contracts.ts";
import { validateCapabilityContext } from "./capabilities.ts";
import type { AssetResult } from "../failures.ts";
import { codeUnitCompare } from "../ordering.ts";
import type {
  AssetCandidate,
  CandidateReason,
  CandidateRecord,
  CandidateState,
  DependencyCause,
  DependencyOutcome,
  FixedStatus,
  NormalizedCandidate,
  OperationAction,
  OperationConflictEntry,
  OperationCycle,
  OperationFailure,
  OperationPass,
  ResolutionConflict,
  ResolutionResult,
  ResolveScopeInput,
  SelectionPass,
} from "./resolution-types.ts";
import {
  deduplicateExactCandidates,
  candidatePath,
  detail,
  invalidDirectoryReason,
  invalidRequest,
  isRecord,
  normalizeCandidateDirectory,
  toResolutionContextSafely,
  validateCandidate,
} from "./candidate-validation.ts";
import { matchesScope } from "./scope-matching.ts";
import { hasUnresolvedIdentityPair, isSameIdOverlayPair, statusForState } from "./protection-overlay.ts";
import { buildCapabilityOutcomeByState, dependencyOutcomes } from "./dependency-evaluation.ts";
import { stronglyConnectedComponents } from "./graph.ts";
import { selectExclusiveWinner, selectUnbeaten } from "./ranking-precedence.ts";
import {
  canonicalIds,
  compareCandidatesForOutput,
  conflictKey,
  resolutionConflictReason,
} from "./result-assembly.ts";






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
  const contextResult = toResolutionContextSafely(input?.scope);
  if (!contextResult.ok) return contextResult;
  if (!isRecord(input) || !isRecord(input.snapshot) || !Array.isArray(input.snapshot.candidates)) {
    return invalidRequest([detail(["snapshot", "candidates"], "invalid_value", "Snapshot candidates must be a list.")]);
  }
  const contracts = input.contracts ?? DEFAULT_ASSET_TYPE_CONTRACTS;
  const capabilityContextResult = input.capabilityContext === undefined
    ? undefined
    : validateCapabilityContext(input.capabilityContext);
  if (capabilityContextResult !== undefined && !capabilityContextResult.ok) {
    // The helper reports against its own input, so its paths name `catalog` / `offers`,
    // neither of which is a field of ResolveScopeInput.  Rooting them at the field the
    // caller passed is what lets a consumer find the offending value.
    return invalidRequest((capabilityContextResult.failure.details ?? []).map((item) =>
      detail(["capabilityContext", ...item.path], item.code, item.message)));
  }
  const capabilityContext = capabilityContextResult === undefined || !capabilityContextResult.ok
    ? undefined
    : capabilityContextResult.value;

  const conflicts = new Map<string, ResolutionConflict>();
  const addConflict = (conflict: ResolutionConflict): void => {
    const canonical: ResolutionConflict = {
      ...conflict,
      involvedAssetIds: canonicalIds(conflict.involvedAssetIds),
    } as ResolutionConflict;
    conflicts.set(conflictKey(canonical), canonical);
  };


  const records: CandidateRecord[] = [];
  const invalidStates: CandidateState[] = [];
  const normalizedCandidates: NormalizedCandidate[] = [];
  const validationDetails: CoreErrorDetail[] = [];

  // Structural validation is deliberately completed before directory
  // partitioning.  A malformed candidate must never become a successful
  // invalid-directory evaluation, and it must not be dereferenced below.
  for (const rawCandidate of input.snapshot.candidates) {
    const candidate = rawCandidate as AssetCandidate;
    const structuralDetails = validateCandidate({ candidate }, contracts, capabilityContext);
    if (structuralDetails.length > 0) {
      validationDetails.push(...structuralDetails);
      continue;
    }
    const normalized = normalizeCandidateDirectory(candidate);
    records.push({
      candidate,
      ...(normalized.candidate === undefined ? {} : { normalized: normalized.candidate }),
      ...(normalized.diagnostics === undefined ? {} : { directoryDiagnostics: normalized.diagnostics }),
    });
  }
  if (validationDetails.length > 0) return invalidRequest(validationDetails);

  // Payload consistency is an identity invariant over every structurally
  // valid record, including records whose directory is later excluded.
  const payloadByIdentity = new Map<string, { assetType: AssetType; loadingTier: LoadingTier }>();
  for (const record of records) {
    const { candidate } = record;
    const identity = `${String(candidate.assetId)}\u0000${String(candidate.revision)}`;
    const previous = payloadByIdentity.get(identity);
    if (previous === undefined) {
      payloadByIdentity.set(identity, { assetType: candidate.assetType, loadingTier: candidate.loadingTier });
    } else if (previous.assetType !== candidate.assetType || previous.loadingTier !== candidate.loadingTier) {
      validationDetails.push(detail(
        candidatePath(candidate),
        "invalid_value",
        "Candidates with the same asset identity must have the same payload type and loading tier.",
      ));
    }
  }
  if (validationDetails.length > 0) return invalidRequest(validationDetails);

  for (const record of records) {
    if (record.directoryDiagnostics !== undefined) {
      invalidStates.push({
        candidate: record.candidate,
        matched: false,
        reason: invalidDirectoryReason(record.directoryDiagnostics),
      });
    } else if (record.normalized !== undefined) {
      normalizedCandidates.push(record.normalized);
    }
  }

  const deduplicated = deduplicateExactCandidates(normalizedCandidates);
  const states: CandidateState[] = deduplicated.map((normalized) => ({
    candidate: normalized.candidate,
    matched: false,
    reason: { kind: "excluded", cause: "scope_mismatch", mismatchedAxes: [] },
  }));

  for (const state of states) {
    const decision = matchesScope({ candidate: state.candidate }, contextResult.value);
    if (decision.matched) {
      state.matched = true;
      state.rank = decision.rank;
      state.reason = { kind: "included", matchedAxes: decision.matchedAxes, rank: decision.rank };
    } else {
      state.reason = { kind: "excluded", cause: "scope_mismatch", mismatchedAxes: decision.mismatchedAxes };
    }
  }

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

  const makeOperationConflict = (targetAssetId: AssetId, involvedAssetIds: readonly AssetId[]): ResolutionConflict => ({
    kind: "operation_conflict",
    targetAssetId,
    involvedAssetIds: canonicalIds(involvedAssetIds),
  });

  const evaluatePlan = (
    plan: ReadonlySet<CandidateState>,
    forcedConflicts: ReadonlyMap<CandidateState, ResolutionConflict>,
  ): OperationPass => {
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
      if (operation.kind === "override" && (
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
            mergeGroup: action.issuer.candidate.rule.mergeGroup as string,
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

  const runCurrentOperation = (): {
    readonly pass: OperationPass;
    readonly forcedConflicts: ReadonlyMap<CandidateState, ResolutionConflict>;
  } => {
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
        const trialPass = evaluatePlan(trialPlan, forcedConflicts);
        if (trialPass.cycles.length > 0 || operationConflictCandidates(trialPass).size > 0) return undefined;
        if (samePlan(trialPass.nextPlan, trialPlan)) return { plan: trialPlan, pass: trialPass };
        trialPlan = new Set(trialPass.nextPlan);
      }
    };
    const tryAcyclicNoRequirementPlan = (): { readonly plan: ReadonlySet<CandidateState>; readonly pass: OperationPass } | undefined => {
      if (operationIssuers.some((issuer) => issuer.candidate.rule.requires.length > 0)) return undefined;
      const allPass = evaluatePlan(new Set(operationIssuers), forcedConflicts);
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
      const pass = evaluatePlan(active, forcedConflicts);
      if (pass.cycles.length > 0 || operationConflictCandidates(pass).size > 0 || !samePlan(pass.nextPlan, active)) return undefined;
      return { plan: active, pass };
    };

    let finalPass: OperationPass | undefined = tryAcyclicNoRequirementPlan()?.pass;
    if (finalPass === undefined) {
      let plan = new Set(operationIssuers);
      const seenPlans = new Map<string, OperationPass>();
      for (;;) {
        const currentKey = planKey(plan);
        const pass = evaluatePlan(plan, forcedConflicts);
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


  const candidateKey = (state: CandidateState): string =>
    `${String(state.candidate.assetId)}\u0000${String(state.candidate.revision)}\u0000${state.candidate.source.layer}\u0000${state.candidate.source.sourceId}`;
  const selectCurrent = (): SelectionPass => {
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
  const dynamicReason = (state: CandidateState, pass: OperationPass): CandidateReason | undefined => {
    const status = pass.statuses.get(state);
    if (status?.kind === "disabled") return { kind: "disabled", disabledBy: status.disabledBy };
    if (status?.kind === "overridden") return {
      kind: "overridden",
      overriddenBy: status.overriddenBy,
      mergeGroup: status.mergeGroup,
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
  const currentUnavailableReason = (
    state: CandidateState,
    pass: OperationPass,
  ): CandidateReason | undefined => {
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

  let finalSelection = selectCurrent();
  let operationResult: { readonly pass: OperationPass; readonly forcedConflicts: ReadonlyMap<CandidateState, ResolutionConflict> } | undefined;
  const seenSelections = new Set<string>();
  for (;;) {
    finalSelection = selectCurrent();
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
    operationResult = runCurrentOperation();
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
        const currentEvidence = currentUnavailableReason(state, operationResult.pass);
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
      scope: contextResult.value,
      evaluations: allStates.map((state) => ({ candidate: state.candidate, reason: finalReasons.get(state) ?? state.reason })),
      outcome: resultConflicts.length === 0 ? "resolved" : "conflicted",
      conflicts: resultConflicts,
    },
  };
};

export const resolveScope = (
  input: ResolveScopeInput,
): AssetResult<ResolutionResult> => resolveScopeFixedPoint(input);
