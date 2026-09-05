import type {
  BindingCandidateDto,
  BindingDefinitionDto,
  BindingFallbackRelationDto,
  BindingId,
  BindingScopeDto,
  BindingSourceDto,
  BindingTargetDto,
  BindingTargetAvailabilityDto,
  BindingTargetIssueDto,
  CoreErrorDetail,
  ModelId,
  ProviderId,
  RuntimeId,
} from "@aacl/shared";
import { isProjectMarkerId } from "@aacl/shared";
import type { AssetId } from "@aacl/shared";
import {
  asAssetId,
  parseAssetDocument,
  validateAsset,
  type AssetFieldValue,
  type AssetScopeAxis,
  type CanonicalAsset,
} from "./assets.ts";
import { coreFailure, type AssetResult } from "./failures.ts";
import type { MetadataCatalog } from "./catalog.ts";
import type {
  ResolutionEvaluation,
} from "./resolution/resolution-types.ts";
import { toResolutionReasonDto } from "./resolution/result-assembly.ts";
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
  for (const projectId of asset.scope.project ?? []) {
    if (!isProjectMarkerId(projectId)) {
      details.push(detail(
        ["document", "frontmatter", "scope.project"],
        "invalid_project_id",
        "Binding scope.project values must use the Project marker id shape.",
      ));
    }
  }

  const target = asset.operation === "disable" ? undefined : targetFromMetadata(asset, details);
  if (asset.operation !== "disable" && target === undefined && details.length === 0) {
    details.push(detail(["document", "frontmatter", "metadata.target-kind"], "invalid_target", "Binding target metadata is invalid."));
  }
  if (asset.operation === "disable" && (Object.hasOwn(asset.metadata, "target-kind") || Object.hasOwn(asset.metadata, "provider-id") || Object.hasOwn(asset.metadata, "runtime-id") || Object.hasOwn(asset.metadata, "model-id") || Object.hasOwn(asset.metadata, "fallback-for"))) {
    details.push(detail(["document", "frontmatter", "metadata"], "disable_target_metadata", "A disabled Binding must not declare target or fallback metadata."));
  }
  const fallbackValue = scalarMetadata(asset, "fallback-for", details, false);
  const fallbackAssetId = fallbackValue === undefined ? undefined : asAssetId(fallbackValue);
  const fallbackFor = fallbackAssetId?.ok === true ? asBindingId(fallbackAssetId.value) : undefined;
  if (fallbackAssetId?.ok === false) {
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
const targetIssues = (binding: CanonicalBinding, catalog: MetadataCatalog): BindingTargetIssueDto[] => {
  const target = binding.target;
  if (target === undefined) return [];
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

const targetAvailability = (binding: CanonicalBinding, catalog: MetadataCatalog): BindingTargetAvailabilityDto => {
  const issues = targetIssues(binding, catalog);
  return issues.length === 0 ? { status: "available" } : { status: "unavailable", issues };
};

const cycleFrom = (
  binding: CanonicalBinding,
  fallbackIds: ReadonlyMap<BindingId, readonly BindingId[]>,
): readonly BindingId[] | undefined => {
  const primary = binding.fallbackFor;
  if (primary === undefined) return undefined;
  const visit = (current: BindingId, path: readonly BindingId[]): readonly BindingId[] | undefined => {
    const repeatedAt = path.indexOf(current);
    if (repeatedAt >= 0) return [...path.slice(repeatedAt), current];
    for (const next of fallbackIds.get(current) ?? []) {
      const cycle = visit(next, [...path, current]);
      if (cycle !== undefined) return cycle;
    }
    return undefined;
  };
  return visit(primary, [binding.bindingId]);
};

const fallbackRelation = (
  binding: CanonicalBinding,
  bindingIds: ReadonlySet<BindingId>,
  fallbackIds: ReadonlyMap<BindingId, readonly BindingId[]>,
): BindingFallbackRelationDto => {
  const primaryBindingId = binding.fallbackFor;
  if (primaryBindingId === undefined) return { kind: "none" };
  if (!bindingIds.has(primaryBindingId)) return { kind: "missing", primaryBindingId };
  const cycle = cycleFrom(binding, fallbackIds);
  return cycle === undefined
    ? { kind: "linked", primaryBindingId }
    : { kind: "cycle", primaryBindingId, cycle: [...cycle] };
};

/** Resolve validated binding assets without choosing a winner or creating an assignment. */
export const resolveBindings = (input: BindingResolutionInput): AssetResult<BindingResolutionResult> => {
  const sourceMismatch = input.entries.find(({ evaluation, source }) => evaluation.candidate.source.layer !== source.layer);
  if (sourceMismatch !== undefined) {
    return invalidBinding([detail(
      ["entries", String(sourceMismatch.binding.bindingId), "source", "layer"],
      "binding_source_mismatch",
      "The Binding source layer must match its resolution candidate source layer.",
    )]);
  }
  const entries = [...input.entries].sort((left, right) => codeUnitCompare(entryKey(left), entryKey(right)));
  const bindingIds = new Set(entries
    .filter(({ binding }) => binding.asset.operation !== "disable")
    .map(({ binding }) => binding.bindingId));
  const fallbackIds = new Map<BindingId, BindingId[]>();
  for (const { binding } of entries) {
    if (binding.fallbackFor === undefined) continue;
    const targets = fallbackIds.get(binding.bindingId) ?? [];
    if (!targets.includes(binding.fallbackFor)) targets.push(binding.fallbackFor);
    fallbackIds.set(binding.bindingId, targets);
  }
  const diagnostics: Detail[] = [];
  const candidates: BindingCandidateDto[] = [];
  for (const item of entries) {
    const { binding } = item;
    const candidateBase = {
      revision: item.evaluation.candidate.revision,
      source: item.source,
      loadingTier: item.evaluation.candidate.loadingTier,
      applicability: toResolutionReasonDto(item.evaluation.reason),
    };
    if (binding.asset.operation === "disable") {
      candidates.push({
        operation: "disable",
        bindingId: binding.bindingId,
        ...(bindingScope(binding.asset) === undefined ? {} : { scope: bindingScope(binding.asset) }),
        ...candidateBase,
      });
      continue;
    }
    candidates.push({
      operation: binding.asset.operation,
      definition: definitionDto(binding)!,
      targetAvailability: targetAvailability(binding, input.catalog),
      fallbackRelation: fallbackRelation(binding, bindingIds, fallbackIds),
      ...candidateBase,
    });
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

const candidateSortKey = (candidate: BindingCandidateDto): string => {
  const definition = candidate.operation === "disable" ? undefined : candidate.definition;
  return [
    candidate.operation,
    candidate.operation === "disable" ? candidate.bindingId : candidate.definition.bindingId,
    candidate.source.layer,
    candidate.source.layer === "project" ? candidate.source.projectId : "",
    candidate.revision,
    candidate.loadingTier,
  ].join("\u0000");
};
