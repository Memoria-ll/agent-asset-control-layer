import type { CoreErrorDetail, ProjectId, RoleId, StageId, TaskTypeId, WorkflowId } from "@aacl/shared";
import { codeUnitCompare } from "../ordering.ts";
import { coreFailure, type AssetResult } from "../failures.ts";
import { isLowerKebabToken } from "../tokens.ts";
import type { ResolutionContext } from "../resolution/resolution-context.ts";
import {
  featureSetContains,
  validateCapabilityContext,
  type CapabilityCatalog,
  type CapabilityFeatureId,
  type CapabilityId,
  type CapabilityOffer,
  type CapabilityReference,
  type CapabilityResolutionContext,
} from "./dependencies.ts";

declare const toolBindingIdBrand: unique symbol;
declare const toolProviderIdBrand: unique symbol;
declare const toolIdBrand: unique symbol;

export type ToolBindingId = string & { readonly [toolBindingIdBrand]: true };
export type ToolProviderId = string & { readonly [toolProviderIdBrand]: true };
export type ToolId = string & { readonly [toolIdBrand]: true };

export type ToolTarget =
  | { readonly kind: "provider"; readonly toolProviderId: ToolProviderId }
  | { readonly kind: "tool"; readonly toolProviderId: ToolProviderId; readonly toolId: ToolId };

export type ProjectToolBindingScope = {
  readonly workflowId?: readonly WorkflowId[];
  readonly stageId?: readonly StageId[];
  readonly roleId?: readonly RoleId[];
  readonly taskTypeId?: readonly TaskTypeId[];
};

export type ProjectToolBinding = {
  readonly bindingId: ToolBindingId;
  readonly projectId: ProjectId;
  readonly capability: CapabilityReference;
  readonly target: ToolTarget;
  readonly scope?: ProjectToolBindingScope;
  readonly enabled: boolean;
};

export type ToolObservation = {
  readonly target: ToolTarget;
  readonly state: "available" | "unavailable" | "unknown";
};

export type ToolPermissionDecision = {
  readonly bindingId: ToolBindingId;
  readonly decision: "allowed" | "denied" | "unknown";
};

export type CapabilityBindingScopeState = "matched" | "out_of_scope";
export type CapabilityBindingObservation = ToolObservation["state"] | "missing";
export type CapabilityBindingPermission = ToolPermissionDecision["decision"];

export type CapabilityBindingReason =
  | { readonly kind: "project_context_missing" }
  | { readonly kind: "project_mismatch" }
  | { readonly kind: "context_missing"; readonly axis: keyof ProjectToolBindingScope }
  | { readonly kind: "scope_mismatch"; readonly axis: keyof ProjectToolBindingScope }
  | { readonly kind: "binding_disabled" }
  | { readonly kind: "observation_missing" }
  | { readonly kind: "observation_unavailable" }
  | { readonly kind: "observation_unknown" }
  | { readonly kind: "permission_denied" }
  | { readonly kind: "permission_unknown" }
  | { readonly kind: "eligible" };

export type CapabilityBindingEvaluation = {
  readonly bindingId: ToolBindingId;
  readonly capability: CapabilityReference;
  readonly target: ToolTarget;
  readonly scope: CapabilityBindingScopeState;
  readonly enabled: boolean;
  readonly observation: CapabilityBindingObservation;
  readonly permission: CapabilityBindingPermission;
  readonly eligible: boolean;
  readonly reasons: readonly CapabilityBindingReason[];
};

export type CapabilityAvailabilityReason =
  | { readonly kind: "no_applicable_binding" }
  | { readonly kind: "no_available_binding" }
  | { readonly kind: "available_but_denied" }
  | { readonly kind: "available_but_permission_unknown" }
  | { readonly kind: "allowed_bindings_available" };

export type CapabilityAvailabilityResult = {
  readonly capability: CapabilityReference;
  readonly availability: "available" | "unavailable";
  readonly permission: "allowed" | "denied" | "unknown";
  readonly bindingIds: readonly ToolBindingId[];
  readonly eligibleBindingIds?: readonly ToolBindingId[];
  readonly reasons: readonly CapabilityAvailabilityReason[];
};

export type ToolExecutionCandidate = {
  readonly bindingId: ToolBindingId;
  readonly capability: CapabilityReference;
  readonly target: ToolTarget;
};

export type ResolveCapabilityBindingsInput = {
  readonly context: ResolutionContext;
  readonly catalog: CapabilityCatalog;
  readonly bindings: readonly ProjectToolBinding[];
  readonly observations: readonly ToolObservation[];
  readonly permissions: readonly ToolPermissionDecision[];
};

export type CapabilityBindingResolution = {
  readonly capabilityContext: CapabilityResolutionContext;
  readonly evaluations: readonly CapabilityBindingEvaluation[];
  readonly capabilityResults: readonly CapabilityAvailabilityResult[];
  readonly executionCandidates: readonly ToolExecutionCandidate[];
};

type RecordValue = Record<string, unknown>;
type ScopeAxis = keyof ProjectToolBindingScope;

const SCOPE_AXES: readonly ScopeAxis[] = ["workflowId", "stageId", "roleId", "taskTypeId"];
const CONTEXT_KEYS = new Set([
  "projectId", "workflowId", "stageId", "roleId", "taskTypeId", "providerId", "runtimeId", "modelId", "directory",
]);

const isRecord = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const detail = (path: readonly string[], code: string, message: string): CoreErrorDetail => ({
  path: [...path],
  code,
  message,
});

const invalidInput = (details: readonly CoreErrorDetail[]): AssetResult<never> => ({
  ok: false,
  failure: coreFailure("invalid_request", "The capability binding input is invalid.", details),
});

const hasOnlyKeys = (value: RecordValue, allowed: readonly string[], path: readonly string[], details: CoreErrorDetail[]): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) details.push(detail([...path, key], "unknown_key", `Unknown key "${key}".`));
  }
};

const isSortedUnique = (values: readonly string[]): boolean =>
  values.every((value, index) => index === 0 || codeUnitCompare(values[index - 1] ?? "", value) < 0);

const referenceKey = (reference: CapabilityReference): string =>
  JSON.stringify([reference.capabilityId, reference.features === undefined ? null : reference.features]);

const targetKey = (target: ToolTarget): string => target.kind === "provider"
  ? JSON.stringify([target.kind, target.toolProviderId, null])
  : JSON.stringify([target.kind, target.toolProviderId, target.toolId]);

const cloneTarget = (target: ToolTarget): ToolTarget => target.kind === "provider"
  ? { kind: target.kind, toolProviderId: target.toolProviderId }
  : { kind: target.kind, toolProviderId: target.toolProviderId, toolId: target.toolId };

const cloneReference = (reference: CapabilityReference): CapabilityReference => reference.features === undefined
  ? { capabilityId: reference.capabilityId }
  : { capabilityId: reference.capabilityId, features: [...reference.features] };

const parseTarget = (value: unknown, path: readonly string[], details: CoreErrorDetail[]): ToolTarget | undefined => {
  if (!isRecord(value)) {
    details.push(detail(path, "invalid_target", "The tool target must be an object."));
    return undefined;
  }
  const kind = value.kind;
  if (kind === "provider") {
    hasOnlyKeys(value, ["kind", "toolProviderId"], path, details);
    if (!isNonEmptyString(value.toolProviderId)) {
      details.push(detail([...path, "toolProviderId"], "invalid_tool_provider_id", "The tool provider id must not be empty."));
      return undefined;
    }
    return { kind, toolProviderId: value.toolProviderId as ToolProviderId };
  }
  if (kind === "tool") {
    hasOnlyKeys(value, ["kind", "toolProviderId", "toolId"], path, details);
    if (!isNonEmptyString(value.toolProviderId)) details.push(detail([...path, "toolProviderId"], "invalid_tool_provider_id", "The tool provider id must not be empty."));
    if (!isNonEmptyString(value.toolId)) details.push(detail([...path, "toolId"], "invalid_tool_id", "The tool id must not be empty."));
    if (!isNonEmptyString(value.toolProviderId) || !isNonEmptyString(value.toolId)) return undefined;
    return { kind, toolProviderId: value.toolProviderId as ToolProviderId, toolId: value.toolId as ToolId };
  }
  details.push(detail([...path, "kind"], "invalid_target_kind", "The tool target kind is unknown."));
  return undefined;
};

const parseReference = (
  value: unknown,
  path: readonly string[],
  catalog: CapabilityCatalog,
  details: CoreErrorDetail[],
): CapabilityReference | undefined => {
  if (!isRecord(value)) {
    details.push(detail(path, "invalid_capability_reference", "The capability reference must be an object."));
    return undefined;
  }
  hasOnlyKeys(value, ["capabilityId", "features"], path, details);
  if (!isNonEmptyString(value.capabilityId) || !isLowerKebabToken(value.capabilityId)) {
    details.push(detail([...path, "capabilityId"], "invalid_capability_id", "The capability id must be a lower-kebab token."));
    return undefined;
  }
  const capabilityId = value.capabilityId as CapabilityId;
  const definition = catalog.get(capabilityId);
  if (definition === undefined) details.push(detail([...path, "capabilityId"], "unknown_capability_id", `Capability "${capabilityId}" is not declared in the catalog.`));
  if (!Object.hasOwn(value, "features") || value.features === undefined) return { capabilityId };
  if (!Array.isArray(value.features) || value.features.length === 0) {
    details.push(detail([...path, "features"], "invalid_feature_list", "The feature list must contain at least one feature."));
    return undefined;
  }
  const features: CapabilityFeatureId[] = [];
  for (const [index, feature] of value.features.entries()) {
    if (!isNonEmptyString(feature) || !isLowerKebabToken(feature)) details.push(detail([...path, "features", String(index)], "invalid_feature_id", "The capability feature id must be a lower-kebab token."));
    else features.push(feature as CapabilityFeatureId);
  }
  if (features.length !== value.features.length) return undefined;
  if (!isSortedUnique(features)) details.push(detail([...path, "features"], "non_canonical_feature_list", "Feature ids must be sorted and unique."));
  if (definition !== undefined && !featureSetContains(definition.features, features)) {
    details.push(detail([...path, "features"], "unknown_capability_feature", `Capability "${capabilityId}" does not declare the requested features.`));
  }
  return { capabilityId, features };
};

const parseScope = (value: unknown, path: readonly string[], details: CoreErrorDetail[]): ProjectToolBindingScope | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    details.push(detail(path, "invalid_scope", "The binding scope must be an object."));
    return undefined;
  }
  hasOnlyKeys(value, SCOPE_AXES, path, details);
  const scope: {
    workflowId?: WorkflowId[];
    stageId?: StageId[];
    roleId?: RoleId[];
    taskTypeId?: TaskTypeId[];
  } = {};
  for (const axis of SCOPE_AXES) {
    if (!Object.hasOwn(value, axis)) continue;
    const selector = value[axis];
    if (!Array.isArray(selector) || selector.length === 0 || selector.some((item) => !isNonEmptyString(item))) {
      details.push(detail([...path, axis], "invalid_scope_selector", "Scope selectors must be non-empty string arrays."));
      continue;
    }
    if (!isSortedUnique(selector)) details.push(detail([...path, axis], "non_canonical_scope_selector", "Scope selectors must be sorted and unique."));
    switch (axis) {
      case "workflowId": scope.workflowId = selector as WorkflowId[]; break;
      case "stageId": scope.stageId = selector as StageId[]; break;
      case "roleId": scope.roleId = selector as RoleId[]; break;
      case "taskTypeId": scope.taskTypeId = selector as TaskTypeId[]; break;
    }
  }
  return scope;
};

const validateContext = (value: unknown, details: CoreErrorDetail[]): ResolutionContext | undefined => {
  if (!isRecord(value)) {
    details.push(detail(["context"], "invalid_context", "The resolution context must be an object."));
    return undefined;
  }
  hasOnlyKeys(value, [...CONTEXT_KEYS], ["context"], details);
  const context: Record<string, string> = {};
  for (const key of CONTEXT_KEYS) {
    if (!Object.hasOwn(value, key)) continue;
    if (!isNonEmptyString(value[key])) details.push(detail(["context", key], "invalid_context_axis", "Context identifiers must not be empty."));
    else context[key] = value[key];
  }
  return context as ResolutionContext;
};

const parseBinding = (
  value: unknown,
  index: number,
  catalog: CapabilityCatalog,
  details: CoreErrorDetail[],
): ProjectToolBinding | undefined => {
  const path = ["bindings", String(index)];
  if (!isRecord(value)) {
    details.push(detail(path, "invalid_binding", "The project tool binding must be an object."));
    return undefined;
  }
  hasOnlyKeys(value, ["bindingId", "projectId", "capability", "target", "scope", "enabled"], path, details);
  if (!isNonEmptyString(value.bindingId)) details.push(detail([...path, "bindingId"], "invalid_tool_binding_id", "The binding id must not be empty."));
  if (!isNonEmptyString(value.projectId)) details.push(detail([...path, "projectId"], "invalid_project_id", "The project id must not be empty."));
  if (typeof value.enabled !== "boolean") details.push(detail([...path, "enabled"], "invalid_value", "Binding enabled must be boolean."));
  const capability = parseReference(value.capability, [...path, "capability"], catalog, details);
  const target = parseTarget(value.target, [...path, "target"], details);
  const scope = parseScope(value.scope, [...path, "scope"], details);
  if (!isNonEmptyString(value.bindingId) || !isNonEmptyString(value.projectId) || typeof value.enabled !== "boolean" || capability === undefined || target === undefined) return undefined;
  return {
    bindingId: value.bindingId as ToolBindingId,
    projectId: value.projectId as ProjectId,
    capability,
    target,
    ...(scope === undefined ? {} : { scope }),
    enabled: value.enabled,
  };
};

const parseObservation = (value: unknown, index: number, details: CoreErrorDetail[]): ToolObservation | undefined => {
  const path = ["observations", String(index)];
  if (!isRecord(value)) {
    details.push(detail(path, "invalid_observation", "The tool observation must be an object."));
    return undefined;
  }
  hasOnlyKeys(value, ["target", "state"], path, details);
  const target = parseTarget(value.target, [...path, "target"], details);
  if (value.state !== "available" && value.state !== "unavailable" && value.state !== "unknown") details.push(detail([...path, "state"], "invalid_observation_state", "The observation state is unknown."));
  if (target === undefined || (value.state !== "available" && value.state !== "unavailable" && value.state !== "unknown")) return undefined;
  return { target, state: value.state };
};

const parsePermission = (value: unknown, index: number, details: CoreErrorDetail[]): ToolPermissionDecision | undefined => {
  const path = ["permissions", String(index)];
  if (!isRecord(value)) {
    details.push(detail(path, "invalid_permission", "The tool permission decision must be an object."));
    return undefined;
  }
  hasOnlyKeys(value, ["bindingId", "decision"], path, details);
  if (!isNonEmptyString(value.bindingId)) details.push(detail([...path, "bindingId"], "invalid_tool_binding_id", "The binding id must not be empty."));
  if (value.decision !== "allowed" && value.decision !== "denied" && value.decision !== "unknown") details.push(detail([...path, "decision"], "invalid_permission_decision", "The permission decision is unknown."));
  if (!isNonEmptyString(value.bindingId) || (value.decision !== "allowed" && value.decision !== "denied" && value.decision !== "unknown")) return undefined;
  return { bindingId: value.bindingId as ToolBindingId, decision: value.decision };
};

const reasonOrder = (reason: CapabilityBindingReason): string => `${reason.kind}\u0000${"axis" in reason ? reason.axis : ""}`;
const scopeMatches = (binding: ProjectToolBinding, context: ResolutionContext): { state: CapabilityBindingScopeState; reasons: CapabilityBindingReason[] } => {
  const reasons: CapabilityBindingReason[] = [];
  if (context.projectId === undefined) reasons.push({ kind: "project_context_missing" });
  else if (context.projectId !== binding.projectId) reasons.push({ kind: "project_mismatch" });
  for (const axis of SCOPE_AXES) {
    const selector = binding.scope?.[axis];
    if (selector === undefined) continue;
    const value = context[axis];
    if (value === undefined) reasons.push({ kind: "context_missing", axis });
    else if (!(selector as readonly string[]).includes(value)) reasons.push({ kind: "scope_mismatch", axis });
  }
  return { state: reasons.length === 0 ? "matched" : "out_of_scope", reasons };
};

const cloneCatalog = (catalog: CapabilityCatalog): CapabilityCatalog => new Map(
  [...catalog.entries()].map(([id, definition]) => [id, {
    capabilityId: definition.capabilityId,
    displayName: definition.displayName,
    features: [...definition.features],
  }]),
);

/**
 * Resolve project tool bindings without performing I/O. The caller supplies one
 * binding, observation, and permission snapshot; this result produces both
 * execution candidates and the providerless context consumed by the Resolver.
 */
export const resolveCapabilityBindings = (
  input: ResolveCapabilityBindingsInput,
): AssetResult<CapabilityBindingResolution> => {
  const details: CoreErrorDetail[] = [];
  if (!isRecord(input)) return invalidInput([detail([], "invalid_input", "The input must be an object.")]);
  hasOnlyKeys(input, ["context", "catalog", "bindings", "observations", "permissions"], [], details);
  const context = validateContext(input.context, details);
  if (!(input.catalog instanceof Map)) details.push(detail(["catalog"], "invalid_catalog", "The capability catalog must be a map."));
  const catalogResult = input.catalog instanceof Map
    ? validateCapabilityContext({ catalog: input.catalog, offers: [] })
    : undefined;
  if (catalogResult !== undefined && !catalogResult.ok) details.push(...(catalogResult.failure.details ?? []));
  const catalog = catalogResult?.ok ? catalogResult.value.catalog : undefined;
  if (!Array.isArray(input.bindings)) details.push(detail(["bindings"], "invalid_bindings", "Bindings must be an array."));
  if (!Array.isArray(input.observations)) details.push(detail(["observations"], "invalid_observations", "Observations must be an array."));
  if (!Array.isArray(input.permissions)) details.push(detail(["permissions"], "invalid_permissions", "Permissions must be an array."));
  if (context === undefined || catalog === undefined || !Array.isArray(input.bindings) || !Array.isArray(input.observations) || !Array.isArray(input.permissions)) return invalidInput(details);

  const bindings: ProjectToolBinding[] = [];
  const bindingIds = new Set<string>();
  for (const [index, value] of input.bindings.entries()) {
    const binding = parseBinding(value, index, catalog, details);
    if (binding === undefined) continue;
    if (bindingIds.has(binding.bindingId)) details.push(detail(["bindings", String(index), "bindingId"], "duplicate_binding_id", `Binding id "${binding.bindingId}" is duplicated.`));
    bindingIds.add(binding.bindingId);
    bindings.push(binding);
  }
  const observations: ToolObservation[] = [];
  const observationKeys = new Set<string>();
  for (const [index, value] of input.observations.entries()) {
    const observation = parseObservation(value, index, details);
    if (observation === undefined) continue;
    const key = targetKey(observation.target);
    if (observationKeys.has(key)) details.push(detail(["observations", String(index), "target"], "duplicate_observation_target", "A target may have only one observation."));
    observationKeys.add(key);
    observations.push(observation);
  }
  const permissions: ToolPermissionDecision[] = [];
  const permissionIds = new Set<string>();
  for (const [index, value] of input.permissions.entries()) {
    const permission = parsePermission(value, index, details);
    if (permission === undefined) continue;
    if (!bindingIds.has(permission.bindingId)) details.push(detail(["permissions", String(index), "bindingId"], "unknown_binding_id", `Permission references unknown binding "${permission.bindingId}".`));
    if (permissionIds.has(permission.bindingId)) details.push(detail(["permissions", String(index), "bindingId"], "duplicate_permission", "A binding may have only one permission decision."));
    permissionIds.add(permission.bindingId);
    permissions.push(permission);
  }
  if (details.length > 0) return invalidInput(details);

  const observationByTarget = new Map(observations.map((observation) => [targetKey(observation.target), observation.state] as const));
  const permissionByBinding = new Map(permissions.map((permission) => [permission.bindingId, permission.decision] as const));
  const evaluations: CapabilityBindingEvaluation[] = [];
  for (const binding of bindings) {
    const scope = scopeMatches(binding, context);
    const observation = observationByTarget.get(targetKey(binding.target)) ?? "missing";
    const permission = permissionByBinding.get(binding.bindingId) ?? "unknown";
    const reasons: CapabilityBindingReason[] = [...scope.reasons];
    if (!binding.enabled) reasons.push({ kind: "binding_disabled" });
    if (observation === "missing") reasons.push({ kind: "observation_missing" });
    else if (observation === "unavailable") reasons.push({ kind: "observation_unavailable" });
    else if (observation === "unknown") reasons.push({ kind: "observation_unknown" });
    if (permission === "denied") reasons.push({ kind: "permission_denied" });
    else if (permission === "unknown") reasons.push({ kind: "permission_unknown" });
    const eligible = scope.state === "matched" && binding.enabled && observation === "available" && permission === "allowed";
    if (eligible) reasons.push({ kind: "eligible" });
    reasons.sort((left, right) => codeUnitCompare(reasonOrder(left), reasonOrder(right)));
    evaluations.push({
      bindingId: binding.bindingId,
      capability: cloneReference(binding.capability),
      target: cloneTarget(binding.target),
      scope: scope.state,
      enabled: binding.enabled,
      observation,
      permission,
      eligible,
      reasons,
    });
  }
  evaluations.sort((left, right) => codeUnitCompare(left.bindingId, right.bindingId));

  const bindingsByGroup = new Map<string, { readonly capability: CapabilityReference; readonly evaluations: CapabilityBindingEvaluation[] }>();
  for (const evaluation of evaluations) {
    const key = referenceKey(evaluation.capability);
    const group = bindingsByGroup.get(key) ?? { capability: evaluation.capability, evaluations: [] };
    group.evaluations.push(evaluation);
    bindingsByGroup.set(key, group);
  }
  const capabilityResults: CapabilityAvailabilityResult[] = [];
  const executionCandidates: ToolExecutionCandidate[] = [];
  for (const [groupKey, group] of [...bindingsByGroup.entries()].sort(([left], [right]) => codeUnitCompare(left, right))) {
    const applicable = group.evaluations.filter((evaluation) => evaluation.scope === "matched" && evaluation.enabled);
    const available = applicable.filter((evaluation) => evaluation.observation === "available");
    const eligible = available.filter((evaluation) => evaluation.permission === "allowed");
    const denied = available.filter((evaluation) => evaluation.permission === "denied");
    const bindingIds = group.evaluations.map((evaluation) => evaluation.bindingId).sort(codeUnitCompare);
    const eligibleBindingIds = eligible.map((evaluation) => evaluation.bindingId).sort(codeUnitCompare);
    const result: CapabilityAvailabilityResult = {
      capability: cloneReference(group.capability),
      availability: available.length > 0 ? "available" : "unavailable",
      permission: eligible.length > 0 ? "allowed" : available.length === 0 ? "unknown" : denied.length > 0 ? "denied" : "unknown",
      bindingIds,
      ...(eligibleBindingIds.length === 0 ? {} : { eligibleBindingIds }),
      reasons: available.length === 0
        ? [{ kind: applicable.length === 0 ? "no_applicable_binding" : "no_available_binding" }]
        : eligible.length > 0
          ? [{ kind: "allowed_bindings_available" }]
          : denied.length > 0
            ? [{ kind: "available_but_denied" }]
            : [{ kind: "available_but_permission_unknown" }],
    };
    capabilityResults.push(result);
    for (const evaluation of eligible) executionCandidates.push({
      bindingId: evaluation.bindingId,
      capability: cloneReference(evaluation.capability),
      target: cloneTarget(evaluation.target),
    });
  }
  executionCandidates.sort((left, right) => {
    const groupOrder = codeUnitCompare(referenceKey(left.capability), referenceKey(right.capability));
    if (groupOrder !== 0) return groupOrder;
    const targetOrder = codeUnitCompare(targetKey(left.target), targetKey(right.target));
    return targetOrder !== 0 ? targetOrder : codeUnitCompare(left.bindingId, right.bindingId);
  });
  const offers: CapabilityOffer[] = capabilityResults
    .filter((result) => result.availability === "available")
    .map((result) => ({
      capabilityId: result.capability.capabilityId,
      features: result.capability.features === undefined ? [] : [...result.capability.features],
      // Unknown authorization is projected as denied for the existing providerless
      // contract; the typed aggregate result retains the unknown state for diagnostics.
      permission: result.permission === "allowed" ? "allowed" : "denied",
    }));
  offers.sort((left, right) => codeUnitCompare(referenceKey({ capabilityId: left.capabilityId, features: left.features }), referenceKey({ capabilityId: right.capabilityId, features: right.features })));
  const capabilityContextResult = validateCapabilityContext({ catalog: cloneCatalog(catalog), offers });
  if (!capabilityContextResult.ok) return { ok: false, failure: capabilityContextResult.failure };
  return {
    ok: true,
    value: {
      capabilityContext: capabilityContextResult.value,
      evaluations,
      capabilityResults,
      executionCandidates,
    },
  };
};
