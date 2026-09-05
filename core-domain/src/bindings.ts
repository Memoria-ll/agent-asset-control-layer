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
      if (reason.cause === "capability_not_allowed") return (reason.failedCapabilities ?? []).map((id) => ({ kind: "capability_not_allowed", capabilityId: id }));
      if (reason.cause === "capability_unavailable") return (reason.failedCapabilities ?? []).map((id) => ({ kind: "capability_unavailable", capabilityId: id }));
      return [{ kind: "invalid_binding", bindingId }];
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
      if (runtime === undefined) return [{ kind: "target_missing", targetId: target.runtimeId }];
      if (model === undefined) return [{ kind: "target_missing", targetId: target.modelId }];
      return runtime.providerId === model.providerId ? [] : [{ kind: "target_provider_mismatch", targetId: target.modelId, providerId: runtime.providerId }];
    }
  }
};

const sortReasons = (left: BindingReasonDto, right: BindingReasonDto): number => codeUnitCompare(JSON.stringify(left), JSON.stringify(right));

/** Resolve validated binding assets without choosing a winner or creating an assignment. */
export const resolveBindings = (input: BindingResolutionInput): AssetResult<BindingResolutionResult> => {
  type BindingState = BindingResolutionEntry & {
    readonly reasons: readonly BindingReasonDto[];
    readonly eligible: boolean;
  };
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
      };
    });
  // `resolveScope` names the offending selector in these diagnostics, and the
  // candidate reason can only carry `invalid_binding`. Dropping them leaves the
  // caller with an unavailable Binding and nothing to correct it by.
  for (const { evaluation } of base) {
    const reason = evaluation.reason;
    if (reason.kind === "excluded" && reason.cause === "invalid_directory") diagnostics.push(...reason.diagnostics);
  }
  const statesByBindingId = new Map<BindingId, BindingState[]>();
  for (const state of base) {
    const states = statesByBindingId.get(state.binding.bindingId) ?? [];
    states.push(state);
    statesByBindingId.set(state.binding.bindingId, states);
  }

  const fallbackIds = new Map<BindingId, BindingId>();
  for (const item of base) {
    if (!item.eligible) continue;
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
    const broken = brokenFallback(item);
    if (broken !== undefined) {
      candidates.push({ status: "unavailable", bindingId: binding.bindingId, ...optionalDefinition(binding), reasons: [{ kind: "invalid_binding", bindingId: binding.bindingId }], ...candidateBase });
      diagnostics.push(detail(
        ["binding", binding.bindingId, "fallbackFor"],
        broken,
        broken === "missing_fallback_primary"
          ? "The fallback primary Binding is missing."
          : "The Binding fallback relation contains a cycle.",
      ));
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
