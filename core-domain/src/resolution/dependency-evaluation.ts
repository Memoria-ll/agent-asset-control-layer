import type { AssetId } from "@aacl/shared";
import { codeUnitCompare } from "../ordering.ts";
import { evaluateCapabilityDependenciesInValidatedContext } from "../capabilities/dependencies.ts";
import type {
  CapabilityDegradation,
  CapabilityDependencyOutcome,
  CapabilityResolutionContext,
} from "../capabilities/dependencies.ts";
import type {
  CandidateReason,
  CandidateState,
  DependencyCause,
  DependencyNode,
  DependencyOutcome,
  FixedStatus,
} from "./resolution-types.ts";
import { canonicalIds, compareCandidatesForOutput } from "./result-assembly.ts";
import { statusForState } from "./protection-overlay.ts";
import { stronglyConnectedComponents } from "./graph.ts";

export const buildCapabilityOutcomeByState = (
  ctx: {
    readonly baseIncluded: ReadonlySet<CandidateState>;
    readonly capabilityContext: CapabilityResolutionContext | undefined;
  },
): ReadonlyMap<CandidateState, CapabilityDependencyOutcome> => {
  const { baseIncluded, capabilityContext } = ctx;
  // Neither a candidate's capability dependencies nor the capability context change
  // across operation passes, so each outcome is settled once here rather than per pass —
  // otherwise every pass re-normalizes the dependencies of every candidate.
  const capabilityOutcomeByState = new Map<CandidateState, CapabilityDependencyOutcome>();
  for (const state of baseIncluded) {
    const dependencies = state.candidate.rule.capabilityDependencies;
    if (dependencies === undefined) continue;
    const capabilityResult = evaluateCapabilityDependenciesInValidatedContext(dependencies, capabilityContext);
    // Structural validation above ran with this same catalog, so a failure here would
    // mean the two disagree rather than that the snapshot is invalid.
    if (!capabilityResult.ok) throw new Error("Validated capability dependencies must evaluate successfully.");
    capabilityOutcomeByState.set(state, capabilityResult.value);
  }
  return capabilityOutcomeByState;
};

export type DependencyEvaluationContext = {
  readonly baseIncluded: ReadonlySet<CandidateState>;
  readonly baseReasons: ReadonlyMap<CandidateState, CandidateReason>;
  readonly selectionEvidence: ReadonlyMap<CandidateState, CandidateReason>;
  readonly capabilityOutcomeByState: ReadonlyMap<CandidateState, CapabilityDependencyOutcome>;
  readonly invalidById: ReadonlySet<string>;
  readonly stateById: ReadonlyMap<string, CandidateState[]>;
};

export const dependencyOutcomes = (
  statuses: ReadonlyMap<CandidateState, FixedStatus>,
  ctx: DependencyEvaluationContext,
): ReadonlyMap<CandidateState, DependencyOutcome> => {
    const { baseIncluded, baseReasons, capabilityOutcomeByState, invalidById, stateById } = ctx;
    const dependencyOutcomeFromCapability = (outcome: CapabilityDependencyOutcome): DependencyOutcome =>
      outcome.ok
        ? {
            ok: true,
            ...(outcome.degradation === undefined ? {} : { degradedInfo: outcome.degradation }),
            ...(outcome.degradedCapabilities === undefined ? {} : { degradedCapabilities: outcome.degradedCapabilities }),
          }
        : {
            ok: false,
            cause: "capability_unavailable",
            failedRequirements: [],
            failedCapabilities: outcome.failedCapabilities,
            nonCycleFailedRequirements: [],
          };

    const degradationOrder = (left: CapabilityDegradation, right: CapabilityDegradation): number => {
      const idOrder = codeUnitCompare(left.capabilityId, right.capabilityId);
      if (idOrder !== 0) return idOrder;
      const strengthOrder = codeUnitCompare(left.strength, right.strength);
      if (strengthOrder !== 0) return strengthOrder;
      return codeUnitCompare(left.fallbackCapabilityId ?? "", right.fallbackCapabilityId ?? "");
    };
    const mergeDegradation = (
      sources: readonly DependencyOutcome[],
    ): Pick<Extract<DependencyOutcome, { readonly ok: true }>, "degradedInfo" | "degradedCapabilities"> => {
      const degradedCapabilities = sources.flatMap((source) => source.ok ? [...(source.degradedCapabilities ?? [])] : []);
      const reasons = sources.flatMap((source) => source.ok ? [...(source.degradedInfo?.reasons ?? [])] : []);
      const orderedDegradations = degradedCapabilities.sort(degradationOrder);
      const uniqueDegradations: CapabilityDegradation[] = [];
      for (const degradation of orderedDegradations) {
        const previous = uniqueDegradations.at(-1);
        if (previous !== undefined && degradationOrder(previous, degradation) === 0) continue;
        uniqueDegradations.push(degradation);
      }
      const uniqueReasons = [...new Set(reasons)].sort(codeUnitCompare);
      if (uniqueDegradations.length === 0) return {};
      // A degraded outcome must retain a reason because DegradedInfo rejects empty lists.
      if (uniqueReasons.length === 0) throw new Error("A degraded capability outcome must include a reason.");
      return {
        degradedCapabilities: uniqueDegradations,
        degradedInfo: { reasons: uniqueReasons },
      };
    };

    const activeById = new Map<string, CandidateState[]>();
    for (const state of baseIncluded) {
      if (statuses.get(state)?.kind !== "included") continue;
      const group = activeById.get(String(state.candidate.assetId)) ?? [];
      group.push(state);
      activeById.set(String(state.candidate.assetId), group);
    }

    const reasonKind = (state: CandidateState): string | undefined => {
      const status = statusForState(state, statuses, ctx);
      if (status !== undefined) return status.kind;
      return baseReasons.get(state)?.kind;
    };
    const classifyMissing = (requiredId: AssetId): DependencyCause => {
      const candidatesForId = stateById.get(String(requiredId)) ?? [];
      const matchedCandidates = candidatesForId.filter((candidate) => candidate.matched);
      if (matchedCandidates.length > 0) {
        const kinds = matchedCandidates.map(reasonKind);
        if (kinds.every((kind) => kind === "disabled")) return "requirement_disabled";
        if (kinds.every((kind) => kind === "overridden")) return "requirement_overridden";
        return "requirement_invalid";
      }
      if (invalidById.has(String(requiredId))) return "requirement_invalid";
      if (candidatesForId.length === 0) return "missing_requirement";
      return "requirement_out_of_scope";
    };

    const dependencyNodes = new Map<CandidateState, DependencyNode>();
    const outgoing = new Map<CandidateState, CandidateState[]>();
    for (const state of baseIncluded) {
      const edges: { requiredId: AssetId; target: CandidateState }[] = [];
      const directFailures: { id: AssetId; cause: DependencyCause }[] = [];
      for (const requiredId of state.candidate.rule.requires) {
        const targets = activeById.get(String(requiredId)) ?? [];
        if (targets.length !== 1) {
          directFailures.push({ id: requiredId, cause: targets.length === 0 ? classifyMissing(requiredId) : "requirement_invalid" });
        } else {
          edges.push({ requiredId, target: targets[0]! });
        }
      }
      const capabilityOutcome = capabilityOutcomeByState.get(state);
      dependencyNodes.set(state, {
        edges,
        directFailures,
        ...(capabilityOutcome === undefined ? {} : { capabilityOutcome }),
      });
      outgoing.set(state, edges.map((edge) => edge.target));
    }

    const reverse = new Map<CandidateState, CandidateState[]>();
    for (const state of baseIncluded) reverse.set(state, []);
    for (const [state, targets] of outgoing) {
      for (const target of targets) {
        const dependents = reverse.get(target) ?? [];
        dependents.push(state);
        reverse.set(target, dependents);
      }
    }
    const ordered = [...baseIncluded].sort(compareCandidatesForOutput);
    const components = stronglyConnectedComponents(ordered, outgoing, compareCandidatesForOutput);
    const componentByState = new Map<CandidateState, number>();
    components.forEach((component, index) => component.forEach((state) => componentByState.set(state, index)));
    const componentDependencies = components.map(() => new Set<number>());
    const componentDependents = components.map(() => new Set<number>());
    for (const [state, targets] of outgoing) {
      const sourceComponent = componentByState.get(state)!;
      for (const target of targets) {
        const targetComponent = componentByState.get(target)!;
        if (sourceComponent === targetComponent) continue;
        componentDependencies[sourceComponent]!.add(targetComponent);
        componentDependents[targetComponent]!.add(sourceComponent);
      }
    }
    const cyclic = new Set<number>();
    for (let index = 0; index < components.length; index += 1) {
      const component = components[index]!;
      if (component.length > 1 || (outgoing.get(component[0]!) ?? []).includes(component[0]!)) cyclic.add(index);
    }

    // Kahn order with a small binary heap keeps long, independent graphs
    // linearithmic without recursion or insertion-order dependence.
    const componentKey = (index: number): CandidateState => components[index]![0]!;
    const ready: number[] = [];
    const heapLess = (left: number, right: number): boolean => compareCandidatesForOutput(componentKey(left), componentKey(right)) < 0;
    const heapPush = (value: number): void => {
      ready.push(value);
      let index = ready.length - 1;
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (!heapLess(value, ready[parent]!)) break;
        ready[index] = ready[parent]!;
        index = parent;
      }
      ready[index] = value;
    };
    const heapPop = (): number | undefined => {
      const first = ready[0];
      const last = ready.pop();
      if (first === undefined) return undefined;
      if (last !== undefined && ready.length > 0) {
        let index = 0;
        while (true) {
          const left = index * 2 + 1;
          if (left >= ready.length) break;
          const right = left + 1;
          const child = right < ready.length && heapLess(ready[right]!, ready[left]!) ? right : left;
          if (!heapLess(ready[child]!, last)) break;
          ready[index] = ready[child]!;
          index = child;
        }
        ready[index] = last;
      }
      return first;
    };
    const remaining = componentDependencies.map((dependencies) => new Set(dependencies));
    for (let index = 0; index < components.length; index += 1) {
      if (remaining[index]!.size === 0) heapPush(index);
    }
    const processed: number[] = [];
    while (ready.length > 0) {
      const component = heapPop()!;
      processed.push(component);
      for (const dependent of componentDependents[component]!) {
        remaining[dependent]!.delete(component);
        if (remaining[dependent]!.size === 0) heapPush(dependent);
      }
    }
    if (processed.length < components.length) {
      // Every remaining component is cyclic, but retain deterministic output
      // if a future graph change ever leaves an unprocessed component.
      for (const index of components.keys()) if (!processed.includes(index)) processed.push(index);
    }

    const outcomes = new Map<CandidateState, DependencyOutcome>();
    for (const componentIndex of processed) {
      const component = components[componentIndex]!;
      const componentStates = new Set(component);
      const componentCycleIds = cyclic.has(componentIndex)
        ? canonicalIds(component.map((state) => state.candidate.assetId))
        : undefined;
      const componentHasNonCycleFailure = component.some((state) => {
        const node = dependencyNodes.get(state)!;
        return node.capabilityOutcome?.ok === false ||
          node.directFailures.some((failure) => failure.cause !== "requirement_cycle") ||
          node.edges.some((edge) => {
            if (componentStates.has(edge.target)) return false;
            const outcome = outcomes.get(edge.target);
            return outcome !== undefined && !outcome.ok && (
              outcome.nonCycleFailedRequirements.length > 0 ||
              (outcome.failedCapabilities?.length ?? 0) > 0
            );
          });
      });
      // Every state of a component reaches every other, so a capability the component
      // cannot satisfy is unsatisfied for all of its members — whether the requirement
      // sits on a member itself or on something a single member requires from outside.
      // Both arrive here, so each member carries the whole set rather than only the part
      // its own edges happen to touch.  Components this one depends on are materialized
      // first and already closed over their own reach, so this single pass is the fixed
      // point; a member's own external edges are re-walked below only for the per-edge
      // requirement diagnostics, which are not shared across the component.
      const componentFailedCapabilities = component.flatMap((state) => {
        const node = dependencyNodes.get(state)!;
        const own = node.capabilityOutcome?.ok === false ? [...node.capabilityOutcome.failedCapabilities] : [];
        const required = node.edges.flatMap((edge) => {
          if (componentStates.has(edge.target)) return [];
          const outcome = outcomes.get(edge.target);
          return outcome === undefined || outcome.ok ? [] : [...(outcome.failedCapabilities ?? [])];
        });
        return [...own, ...required];
      });
      for (const state of component) {
        const node = dependencyNodes.get(state)!;
        const failures = [...node.directFailures];
        const capabilityFailure = node.capabilityOutcome?.ok === false
          ? node.capabilityOutcome
          : undefined;
        const failedCapabilities = [...componentFailedCapabilities];
        const nonCycleFailedRequirements = node.directFailures
          .filter((failure) => failure.cause !== "requirement_cycle")
          .map((failure) => failure.id);
        const outcomeSources: DependencyOutcome[] = [];
        if (node.capabilityOutcome !== undefined) outcomeSources.push(dependencyOutcomeFromCapability(node.capabilityOutcome));
        let cycleIds = componentCycleIds;
        if (componentCycleIds !== undefined) {
          for (const edge of node.edges) {
            if (!componentStates.has(edge.target)) continue;
            failures.push({ id: edge.requiredId, cause: "requirement_cycle" });
            if (componentHasNonCycleFailure) nonCycleFailedRequirements.push(edge.requiredId);
          }
        }
        for (const edge of node.edges) {
          if (componentStates.has(edge.target)) continue;
          const outcome = outcomes.get(edge.target);
          if (outcome === undefined) continue;
          if (outcome.ok) {
            outcomeSources.push(outcome);
            continue;
          }
          failures.push({ id: edge.requiredId, cause: outcome.cause });
          if (outcome.cycleIds !== undefined) {
            cycleIds = cycleIds === undefined ? outcome.cycleIds : canonicalIds([...cycleIds, ...outcome.cycleIds]);
          }
          if (outcome.nonCycleFailedRequirements.length > 0 || (outcome.failedCapabilities?.length ?? 0) > 0) {
            nonCycleFailedRequirements.push(edge.requiredId);
          }
        }
        failures.sort((left, right) => codeUnitCompare(left.id, right.id));
        nonCycleFailedRequirements.sort(codeUnitCompare);
        const uniqueFailedCapabilities = [...new Set(failedCapabilities)].sort(codeUnitCompare);
        if (failures.length === 0 && capabilityFailure === undefined) {
          outcomes.set(state, { ok: true, ...mergeDegradation(outcomeSources) });
        } else {
          const cause = capabilityFailure === undefined
            ? failures[0]!.cause
            : "capability_unavailable";
          outcomes.set(state, {
            ok: false,
            cause,
            failedRequirements: failures.map((failure) => failure.id),
            ...(uniqueFailedCapabilities.length === 0 ? {} : { failedCapabilities: uniqueFailedCapabilities }),
            ...(cycleIds === undefined ? {} : { cycleIds }),
            nonCycleFailedRequirements: canonicalIds(nonCycleFailedRequirements),
          });
        }
      }
    }
    return outcomes;
  };
