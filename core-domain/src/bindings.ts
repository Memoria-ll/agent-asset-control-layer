import type {
  BindingCandidateDto,
  BindingDefinitionDto,
  BindingId,
  BindingReasonDto,
  BindingScopeDto,
  BindingSourceDto,
  BindingTargetDto,
  CoreErrorDetail,
  ModelId,
  ProviderId,
  RuntimeId,
} from "@aacl/shared";
import type { AssetId } from "@aacl/shared";
import { isProjectMarkerId } from "@aacl/shared";
import {
  parseAssetDocument,
  validateAsset,
  type AssetFieldValue,
  type AssetScopeAxis,
  type CanonicalAsset,
} from "./assets.ts";
import { coreFailure, type AssetResult } from "./failures.ts";
import type { MetadataCatalog } from "./catalog.ts";
import type {
  CandidateReason,
  ResolutionEvaluation,
} from "./resolution/resolution-types.ts";
import { codeUnitCompare } from "./ordering.ts";
import { toResolutionConflictDetails } from "./resolution/result-assembly.ts";
import { toAssetCandidate } from "./resolution/asset-candidate-projection.ts";

export const asBindingId = (assetId: AssetId): BindingId => assetId as string as BindingId;
export const bindingAssetId = (bindingId: BindingId): AssetId => bindingId as string as AssetId;

export type CanonicalBinding = {
  readonly asset: CanonicalAsset;
  readonly bindingId: BindingId;
  readonly target?: BindingTargetDto;
  readonly fallbackFor?: BindingId;
  readonly description: string;
};

type Detail = CoreErrorDetail;
const detail = (path: readonly string[], code: string, message: string): Detail => ({
  path: [...path], code, message,
});
const invalidBinding = (details: readonly Detail[]): AssetResult<never> => ({
  ok: false,
  failure: coreFailure("invalid_request", "The canonical Binding is invalid.", details),
});

const scalarMetadata = (
  asset: CanonicalAsset,
  key: string,
  details: Detail[],
  required: boolean,
): string | undefined => {
  const value: AssetFieldValue | undefined = asset.metadata[key];
  if (value === undefined) {
    if (required) details.push(detail(["document", "frontmatter", `metadata.${key}`], "missing_field", `Binding metadata.${key} is required.`));
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    details.push(detail(["document", "frontmatter", `metadata.${key}`], "invalid_value", `Binding metadata.${key} must be a non-empty scalar.`));
    return undefined;
  }
  return value;
};

const bindingScope = (asset: CanonicalAsset): BindingScopeDto | undefined => {
  const values: Partial<Record<keyof BindingScopeDto, readonly string[]>> = {};
  const copy = (source: AssetScopeAxis, target: keyof BindingScopeDto): void => {
    const value = asset.scope[source];
    if (value !== undefined) values[target] = value;
  };
  copy("project", "projectId");
  copy("workflow", "workflowId");
  copy("stage", "stageId");
  copy("task-type", "taskTypeId");
  copy("role", "roleId");
  copy("provider", "providerId");
  copy("runtime", "runtimeId");
  copy("model", "modelId");
  copy("directory", "directory");
  return Object.keys(values).length === 0 ? undefined : values as BindingScopeDto;
};

const targetFromMetadata = (asset: CanonicalAsset, details: Detail[]): BindingTargetDto | undefined => {
  const kind = scalarMetadata(asset, "target-kind", details, true);
  if (kind === undefined) return undefined;
  const providerId = scalarMetadata(asset, "provider-id", details, false);
  const runtimeId = scalarMetadata(asset, "runtime-id", details, false);
  const modelId = scalarMetadata(asset, "model-id", details, false);
  const has = (key: string): boolean => Object.hasOwn(asset.metadata, key);
  if (kind === "provider" && providerId !== undefined && !has("runtime-id") && !has("model-id")) {
    return { kind: "provider", providerId: providerId as ProviderId };
  }
  if (kind === "runtime" && runtimeId !== undefined && !has("provider-id") && !has("model-id")) {
    return { kind: "runtime", runtimeId: runtimeId as RuntimeId };
  }
  if (kind === "model" && modelId !== undefined && !has("provider-id") && !has("runtime-id")) {
    return { kind: "model", modelId: modelId as ModelId };
  }
  if (kind === "runtime-model" && runtimeId !== undefined && modelId !== undefined && !has("provider-id")) {
    return { kind: "runtime-model", runtimeId: runtimeId as RuntimeId, modelId: modelId as ModelId };
  }
  details.push(detail(["document", "frontmatter", "metadata.target-kind"], "invalid_target_fields", `Binding target kind "${kind}" has an invalid set of target metadata fields.`));
  return undefined;
};

/** Validate the binding-specific namespace after the generic asset parser has run. */
export const parseBindingAsset = (asset: CanonicalAsset): AssetResult<CanonicalBinding> => {
  if (asset.type !== "binding") {
    return invalidBinding([detail(["document", "frontmatter", "type"], "wrong_asset_type", 'Asset type must be "binding".')]);
  }
  const details: Detail[] = [];
  const bindingId = asBindingId(asset.id);
  const metadataKeys = Object.keys(asset.metadata);
  const allowed = new Set(["target-kind", "provider-id", "runtime-id", "model-id", "fallback-for"]);
  for (const key of metadataKeys) {
    if (!allowed.has(key)) details.push(detail(["document", "frontmatter", `metadata.${key}`], "unknown_metadata", `Unknown Binding metadata key "${key}".`));
  }

  const target = asset.operation === "disable" ? undefined : targetFromMetadata(asset, details);
  if (asset.operation !== "disable" && target === undefined && details.length === 0) {
    details.push(detail(["document", "frontmatter", "metadata.target-kind"], "invalid_target", "Binding target metadata is invalid."));
  }
  if (asset.operation === "disable" && (Object.hasOwn(asset.metadata, "target-kind") || Object.hasOwn(asset.metadata, "provider-id") || Object.hasOwn(asset.metadata, "runtime-id") || Object.hasOwn(asset.metadata, "model-id") || Object.hasOwn(asset.metadata, "fallback-for"))) {
    details.push(detail(["document", "frontmatter", "metadata"], "disable_target_metadata", "A disabled Binding must not declare target or fallback metadata."));
  }
  // A Project id no Marker can mint names a Project that will never be in any
  // context, so the declared scope could only ever match nothing. Rejecting it
  // here is what keeps such a value out of the published `BindingScopeDto`,
  // which the projection excludes as a diagnostic rather than shipping.
  for (const projectId of asset.scope.project ?? []) {
    if (isProjectMarkerId(projectId)) continue;
    details.push(detail(
      ["document", "frontmatter", "scope.project"],
      "invalid_project_id",
      `Binding scope.project "${projectId}" is not a Project Marker identity.`,
    ));
  }
  const fallbackValue = scalarMetadata(asset, "fallback-for", details, false);
  const fallbackFor = fallbackValue === undefined ? undefined : asBindingId(fallbackValue as AssetId);
  if (fallbackValue !== undefined && !/^(?!.*--)[a-z](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(fallbackValue)) {
    details.push(detail(["document", "frontmatter", "metadata.fallback-for"], "invalid_binding_id", "Binding metadata.fallback-for must be a lowercase kebab identifier."));
  }
  if (asset.operation === "disable" && fallbackFor !== undefined) {
    details.push(detail(["document", "frontmatter", "metadata.fallback-for"], "disable_fallback_metadata", "A disabled Binding must not declare a fallback."));
  }
  if (details.length > 0 || target === undefined && asset.operation !== "disable") return invalidBinding(details);
  return {
    ok: true,
    value: {
      asset,
      bindingId,
      ...(target === undefined ? {} : { target }),
      ...(fallbackFor === undefined ? {} : { fallbackFor }),
      description: asset.body,
    } as CanonicalBinding,
  };
};

export const parseBindingDocument = (source: string): AssetResult<CanonicalBinding> => {
  const parsed = parseAssetDocument(source);
  if (!parsed.ok) return parsed;
  const asset = validateAsset(parsed.value);
  return asset.ok ? parseBindingAsset(asset.value) : asset;
};

export type BindingResolutionInput = {
  readonly entries: readonly BindingResolutionEntry[];
  readonly catalog: MetadataCatalog;
};

export type BindingResolutionEntry = {
  readonly binding: CanonicalBinding;
  readonly evaluation: ResolutionEvaluation;
  readonly source: BindingSourceDto;
};

export type BindingResolutionResult = {
  readonly candidates: readonly BindingCandidateDto[];
  readonly diagnostics: readonly CoreErrorDetail[];
};

const bindingKey = (binding: CanonicalBinding): string => String(binding.bindingId);
const entryKey = (entry: BindingResolutionEntry): string => [
  bindingKey(entry.binding),
  String(entry.evaluation.candidate.revision),
  entry.evaluation.candidate.source.layer,
  entry.evaluation.candidate.source.sourceId,
].join("\u0000");
const targetKey = (target: BindingTargetDto): string => {
  switch (target.kind) {
    case "provider": return `${target.kind}:${target.providerId}`;
    case "runtime": return `${target.kind}:${target.runtimeId}`;
    case "model": return `${target.kind}:${target.modelId}`;
    case "runtime-model": return `${target.kind}:${target.runtimeId}:${target.modelId}`;
  }
};

const requirementReasons = (failedRequirements: readonly AssetId[]): BindingReasonDto[] =>
  failedRequirements.map((requirementId) => ({ kind: "requirement_unavailable", requirementId }));

const reasonForGeneric = (reason: CandidateReason, bindingId: BindingId): BindingReasonDto[] => {
  switch (reason.kind) {
    case "included": {
      const degradedCapabilities = reason.degradedCapabilities?.map((degradation) =>
        degradation.strength === "required"
          ? {
              capabilityId: degradation.capabilityId,
              strength: degradation.strength,
              fallbackCapabilityId: degradation.fallbackCapabilityId,
            }
          : {
              capabilityId: degradation.capabilityId,
              strength: degradation.strength,
              ...(degradation.fallbackCapabilityId === undefined ? {} : { fallbackCapabilityId: degradation.fallbackCapabilityId }),
            });
      return [{
        kind: "eligible",
        ...(degradedCapabilities === undefined ? {} : { degradedCapabilities }),
      }];
    }
    case "excluded":
      if (reason.cause === "scope_mismatch") {
        const axes = reason.mismatchedAxes.length > 0 ? reason.mismatchedAxes : (["directory"] as const);
        return axes.map((axis) => ({ kind: "scope_mismatch", axis }));
      }
      return [{ kind: "invalid_binding", bindingId }];
    case "disabled": return [{ kind: "binding_disabled", actorBindingId: asBindingId(reason.disabledBy) }];
    case "overridden": return [{ kind: "binding_overridden", actorBindingId: asBindingId(reason.overriddenBy) }];
    case "unavailable":
      // Exhaustive on purpose, with no `default`: a cause with no arm of its own
      // used to fall through to `invalid_binding`, which describes a well-formed
      // Binding as malformed and drops the ids the resolver had already worked
      // out. A new cause now leaves this function without a return and fails to
      // compile rather than reaching that fallback.
      // `cause` names the one failure that decided the outcome, but both lists
      // stay populated: a denied capability wins the cause while the Binding's
      // unsatisfied `requires` entries are still in `failedRequirements`. Both
      // are emitted, so neither half of a combined failure is dropped.
      switch (reason.cause) {
        case "capability_not_allowed":
          return [
            ...(reason.failedCapabilities ?? []).map((id) => ({ kind: "capability_not_allowed", capabilityId: id } as const)),
            ...requirementReasons(reason.failedRequirements),
          ];
        case "capability_unavailable":
          return [
            ...(reason.failedCapabilities ?? []).map((id) => ({ kind: "capability_unavailable", capabilityId: id } as const)),
            ...requirementReasons(reason.failedRequirements),
          ];
        case "missing_requirement":
        case "requirement_out_of_scope":
        case "requirement_disabled":
        case "requirement_overridden":
        case "requirement_cycle":
        case "requirement_invalid":
          return requirementReasons(reason.failedRequirements);
      }
  }
};

const targetReason = (binding: CanonicalBinding, catalog: MetadataCatalog): BindingReasonDto[] => {
  const target = binding.target;
  if (target === undefined) return [{ kind: "invalid_binding", bindingId: binding.bindingId }];
  switch (target.kind) {
    case "provider":
      return catalog.providers.has(target.providerId) ? [] : [{ kind: "target_missing", targetId: target.providerId }];
    case "runtime":
      return catalog.runtimes.has(target.runtimeId) ? [] : [{ kind: "target_missing", targetId: target.runtimeId }];
    case "model":
      return catalog.models.has(target.modelId) ? [] : [{ kind: "target_missing", targetId: target.modelId }];
    case "runtime-model": {
      const runtime = catalog.runtimes.get(target.runtimeId);
      const model = catalog.models.get(target.modelId);
      // Both halves are independently actionable, so both are reported: stopping
      // at the first hides the second until the author fixes one and asks again.
      const missing: BindingReasonDto[] = [
        ...(runtime === undefined ? [{ kind: "target_missing", targetId: target.runtimeId } as const] : []),
        ...(model === undefined ? [{ kind: "target_missing", targetId: target.modelId } as const] : []),
      ];
      if (missing.length > 0) return missing;
      // Provider compatibility is only a question once both halves exist.
      return runtime!.providerId === model!.providerId
        ? []
        : [{ kind: "target_provider_mismatch", targetId: target.modelId, providerId: runtime!.providerId }];
    }
  }
};

const sortReasons = (left: BindingReasonDto, right: BindingReasonDto): number => codeUnitCompare(JSON.stringify(left), JSON.stringify(right));

/** Resolve validated binding assets without choosing a winner or creating an assignment. */
export const resolveBindings = (input: BindingResolutionInput): AssetResult<BindingResolutionResult> => {
  type BindingState = BindingResolutionEntry & {
    readonly reasons: readonly BindingReasonDto[];
    readonly eligible: boolean;
    /**
     * The resolver kept this candidate, so its declared fallback relation is in
     * force. Whether the target resolves is a separate question: a Binding with
     * a missing model still forms an edge of the fallback graph, and reading
     * `eligible` here hides exactly those edges from cycle detection.
     */
    readonly included: boolean;
  };
  // Every field of the result is drawn from one of the two halves of an entry —
  // the definition and target from the Binding, the reason, revision and tier
  // from the evaluation — so a pair that names two different assets produces a
  // verdict about neither. This is a published entry point, so the pairing is
  // checked here rather than trusted to the one caller that exists today.
  //
  // The id alone does not settle it: a same-ID Project overlay puts two revisions
  // of one id in the same call, and swapping their evaluations and sources
  // together keeps every id and layer matching. The operation and the tier come
  // from the asset, so they have to be this revision's.
  //
  // Not the whole rule: the projection intersects `scope.project` with the
  // project that owns the file, which only the producer knows, so rebuilding the
  // selectors here rejects legitimate Project overlays. Two revisions that agree
  // on operation and tier and differ only in metadata are therefore still
  // interchangeable — closing that needs the revision hash, which this package
  // cannot compute.
  const identityMismatch = input.entries.find(({ binding, evaluation }) => {
    if (evaluation.candidate.assetType !== "binding") return true;
    if (String(evaluation.candidate.assetId) !== String(binding.bindingId)) return true;
    const expected = toAssetCandidate(binding.asset, {
      revision: evaluation.candidate.revision,
      source: evaluation.candidate.source,
    });
    if (!expected.ok) return true;
    return expected.value.loadingTier !== evaluation.candidate.loadingTier
      || expected.value.rule.operation.kind !== evaluation.candidate.rule.operation.kind;
  });
  if (identityMismatch !== undefined) {
    return invalidBinding([detail(
      ["entries", String(identityMismatch.binding.bindingId), "evaluation", "candidate"],
      "binding_candidate_mismatch",
      "The resolution candidate must be derived from the Binding's own asset revision.",
    )]);
  }
  const sourceMismatch = input.entries.find(({ evaluation, source }) => evaluation.candidate.source.layer !== source.layer);
  if (sourceMismatch !== undefined) {
    return invalidBinding([detail(
      ["entries", String(sourceMismatch.binding.bindingId), "source", "layer"],
      "binding_source_mismatch",
      "The Binding source layer must match its resolution candidate source layer.",
    )]);
  }
  const diagnostics: Detail[] = [];
  const base = [...input.entries]
    .sort((left, right) => codeUnitCompare(entryKey(left), entryKey(right)))
    .map((entry): BindingState => {
      const genericReasons = reasonForGeneric(entry.evaluation.reason, entry.binding.bindingId);
      let reasons: BindingReasonDto[] = genericReasons;
      if (entry.evaluation.reason.kind === "included") {
        const availabilityReasons = targetReason(entry.binding, input.catalog);
        reasons = availabilityReasons.length === 0 ? genericReasons : availabilityReasons;
      }
      return {
        ...entry,
        reasons: [...reasons].sort(sortReasons),
        eligible: reasons.length === 1 && reasons[0]?.kind === "eligible",
        included: entry.evaluation.reason.kind === "included",
      };
    });
  // Every `excluded` cause the candidate reason cannot carry. `scope_mismatch`
  // survives as one reason per axis; the other two collapse to `invalid_binding`,
  // so without this the caller sees an unavailable Binding and nothing to correct
  // it by — neither the offending selector nor which assets conflicted.
  for (const state of base) {
    const reason = state.evaluation.reason;
    if (reason.kind === "excluded") {
      if (reason.cause === "invalid_directory") diagnostics.push(...reason.diagnostics);
      if (reason.cause === "resolution_conflict") diagnostics.push(...toResolutionConflictDetails(reason.conflict));
      continue;
    }
    // The reason arm names which requirement failed; only the resolver knows why.
    if (reason.kind === "unavailable" && reason.failedRequirements.length > 0) {
      diagnostics.push(detail(
        ["binding", String(state.binding.bindingId), "requires"],
        reason.cause,
        `The Binding requirement is unavailable: ${reason.cause}.`,
      ));
    }
  }
  const statesByBindingId = new Map<BindingId, BindingState[]>();
  for (const state of base) {
    const states = statesByBindingId.get(state.binding.bindingId) ?? [];
    states.push(state);
    statesByBindingId.set(state.binding.bindingId, states);
  }

  const fallbackIds = new Map<BindingId, BindingId>();
  for (const item of base) {
    if (!item.included) continue;
    if (item.binding.fallbackFor !== undefined) fallbackIds.set(item.binding.bindingId, item.binding.fallbackFor);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cyclic = new Set<BindingId>();
  const visit = (id: BindingId, path: BindingId[]): void => {
    if (visiting.has(String(id))) {
      const index = path.findIndex((value) => value === id);
      for (const cycleId of path.slice(index < 0 ? 0 : index)) cyclic.add(cycleId);
      return;
    }
    if (visited.has(String(id))) return;
    visiting.add(String(id));
    const primary = fallbackIds.get(id);
    if (primary !== undefined) visit(primary, [...path, id]);
    visiting.delete(String(id));
    visited.add(String(id));
  };
  for (const id of fallbackIds.keys()) visit(id, []);

  /**
   * Why this state's own fallback relation makes it unavailable, whatever its
   * scope and target say. Chain coverage and the candidate loop below read the
   * one predicate, so a Binding the response reports as unavailable can never
   * stand in for the chain it belongs to.
   */
  const brokenFallback = (state: BindingState): "missing_fallback_primary" | "fallback_cycle" | undefined => {
    const primary = state.binding.fallbackFor;
    if (primary !== undefined && !statesByBindingId.has(primary)) return "missing_fallback_primary";
    if (cyclic.has(state.binding.bindingId)) return "fallback_cycle";
    return undefined;
  };

  // Reported for every Binding whose relation is in force, not only for those
  // that would otherwise have been eligible. A cycle whose members all have
  // missing targets is still a cycle, and it is the defect the author has to
  // fix — leaving it to the candidate reason hides it behind `target_missing`.
  for (const state of base) {
    if (!state.included) continue;
    const broken = brokenFallback(state);
    if (broken === undefined) continue;
    diagnostics.push(detail(
      ["binding", String(state.binding.bindingId), "fallbackFor"],
      broken,
      broken === "missing_fallback_primary"
        ? "The fallback primary Binding is missing."
        : "The Binding fallback relation contains a cycle.",
    ));
  }

  /**
   * Whether the preference chain rooted at this Binding already has an eligible
   * member. A fallback activates on the whole chain being unserved, not on its
   * immediate primary standing down: alternating the answer at every edge makes
   * `B -> A` unavailable whenever `A` is eligible, which then activates `C -> B`
   * beside the very `A` that already satisfies the chain.
   */
  const chainCoverage = new Map<BindingId, boolean>();
  const isChainCovered = (id: BindingId, path: ReadonlySet<string> = new Set()): boolean => {
    const cached = chainCoverage.get(id);
    if (cached !== undefined) return cached;
    if (path.has(String(id))) return false;
    const states = statesByBindingId.get(id);
    if (states === undefined) {
      chainCoverage.set(id, false);
      return false;
    }
    const nested = new Set([...path, String(id)]);
    const covered = states.some((state) => {
      // Same admission rule as the fallback graph above: a candidate the
      // resolver dropped neither serves the chain nor lends it its declared
      // edge, so an overridden revision's `fallbackFor` cannot make an id read
      // as covered while the revision that actually applies is unavailable.
      if (!state.included) return false;
      if (brokenFallback(state) !== undefined) return false;
      if (state.eligible) return true;
      const primary = state.binding.fallbackFor;
      return primary !== undefined && isChainCovered(primary, nested);
    });
    chainCoverage.set(id, covered);
    return covered;
  };

  const candidates: BindingCandidateDto[] = [];
  for (const item of base) {
    const { binding } = item;
    // A `disable` record is a directive, not something to bind to: it carries no
    // target by construction, and the Binding it acts on already reports
    // `binding_disabled` naming it. Emitting it would add a candidate that reads
    // as malformed only because it was never a candidate.
    if (binding.asset.operation === "disable") continue;
    const candidateBase = {
      revision: item.evaluation.candidate.revision,
      source: item.source,
      loadingTier: item.evaluation.candidate.loadingTier,
    };
    const primaryId = binding.fallbackFor;
    if (!item.eligible) {
      candidates.push({
        status: "unavailable",
        bindingId: binding.bindingId,
        ...optionalDefinition(binding),
        reasons: (item.reasons.length > 0 ? [...item.reasons] : [{ kind: "invalid_binding", bindingId: binding.bindingId }]) as Extract<BindingCandidateDto, { status: "unavailable" }>['reasons'],
        ...candidateBase,
      });
      continue;
    }
    if (brokenFallback(item) !== undefined) {
      candidates.push({ status: "unavailable", bindingId: binding.bindingId, ...optionalDefinition(binding), reasons: [{ kind: "invalid_binding", bindingId: binding.bindingId }], ...candidateBase });
      continue;
    }
    if (primaryId === undefined) {
      const definition = definitionDto(binding)!;
      const { fallbackFor: _fallbackFor, ...eligibleDefinition } = definition;
      candidates.push({ status: "eligible", definition: eligibleDefinition, reasons: item.reasons as Extract<BindingCandidateDto, { status: "eligible" }>['reasons'], ...candidateBase });
      continue;
    }
    if (isChainCovered(primaryId)) {
      candidates.push({ status: "unavailable", bindingId: binding.bindingId, ...optionalDefinition(binding), reasons: [{ kind: "fallback_not_needed", primaryBindingId: primaryId }], ...candidateBase });
    } else {
      const degradedCapabilities = item.reasons[0]?.kind === "eligible"
        ? item.reasons[0].degradedCapabilities
        : undefined;
      candidates.push({
        status: "fallback",
        definition: { ...definitionDto(binding)!, fallbackFor: primaryId },
        reasons: [{
          kind: "fallback_primary_unavailable",
          primaryBindingId: primaryId,
          ...(degradedCapabilities === undefined ? {} : { degradedCapabilities }),
        }],
        ...candidateBase,
      });
    }
  }
  candidates.sort((left, right) => codeUnitCompare(candidateSortKey(left), candidateSortKey(right)));
  return { ok: true, value: { candidates, diagnostics } };
};

const definitionDto = (binding: CanonicalBinding): BindingDefinitionDto | undefined => {
  if (binding.target === undefined) return undefined;
  return {
    bindingId: binding.bindingId,
    target: binding.target,
    ...(bindingScope(binding.asset) === undefined ? {} : { scope: bindingScope(binding.asset) }),
    ...(binding.fallbackFor === undefined ? {} : { fallbackFor: binding.fallbackFor }),
    description: binding.description,
  };
};

const optionalDefinition = (binding: CanonicalBinding): { readonly definition?: BindingDefinitionDto } => {
  const definition = definitionDto(binding);
  return definition === undefined ? {} : { definition };
};

const candidateSortKey = (candidate: BindingCandidateDto): string => {
  const definition = "definition" in candidate ? candidate.definition : undefined;
  return [
    candidate.status,
    ("bindingId" in candidate ? candidate.bindingId : definition?.bindingId) ?? "",
    definition === undefined ? "" : targetKey(definition.target),
    definition === undefined ? "" : JSON.stringify(definition.scope ?? null),
    definition !== undefined && "fallbackFor" in definition ? definition.fallbackFor ?? "" : "",
    definition?.description ?? "",
    JSON.stringify(candidate.reasons),
    candidate.source.layer,
    candidate.source.layer === "project" ? candidate.source.projectId : "",
    candidate.revision,
    candidate.loadingTier,
  ].join("\u0000");
};
