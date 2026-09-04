import type { DegradedInfo, CoreErrorDetail } from "@aacl/shared";
import { codeUnitCompare } from "../ordering.ts";
import { coreFailure, type AssetResult } from "../failures.ts";

declare const capabilityIdBrand: unique symbol;
declare const capabilityFeatureIdBrand: unique symbol;

export type CapabilityId = string & { readonly [capabilityIdBrand]: true };
export type CapabilityFeatureId = string & { readonly [capabilityFeatureIdBrand]: true };

export type CapabilityDefinition = {
  readonly capabilityId: CapabilityId;
  readonly displayName: string;
  readonly features: readonly CapabilityFeatureId[];
};

export type CapabilityCatalog = ReadonlyMap<CapabilityId, CapabilityDefinition>;

export type CapabilityReference = {
  readonly capabilityId: CapabilityId;
  readonly features?: readonly CapabilityFeatureId[];
};

export type CapabilityDependency =
  | {
      readonly strength: "required" | "optional" | "preferred";
      readonly capability: CapabilityReference;
    }
  | {
      readonly strength: "fallback";
      readonly capability: CapabilityReference;
      readonly fallbackFor: CapabilityReference;
    };

export type CapabilityOffer = {
  readonly capabilityId: CapabilityId;
  readonly features: readonly CapabilityFeatureId[];
  readonly permission: "allowed" | "denied";
};

export type CapabilityResolutionContext = {
  readonly catalog: CapabilityCatalog;
  readonly offers: readonly CapabilityOffer[];
};

export type CapabilityDegradation = {
  readonly capabilityId: CapabilityId;
  readonly strength: "required" | "optional" | "preferred";
  readonly fallbackCapabilityId?: CapabilityId;
};

export type CapabilityDependencyOutcome =
  | {
      readonly ok: true;
      readonly degradation?: DegradedInfo;
      readonly degradedCapabilities?: readonly CapabilityDegradation[];
    }
  | {
      readonly ok: false;
      readonly kind: "unavailable" | "not_allowed";
      readonly failedCapabilities: readonly CapabilityId[];
      readonly reasons: readonly string[];
    };

type CapabilityStrength = CapabilityDependency["strength"];
type PrimaryCapabilityStrength = Exclude<CapabilityStrength, "fallback">;
type RecordValue = Record<string, unknown>;

const isRecord = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object";

const detail = (
  path: readonly string[],
  code: string,
  message: string,
): CoreErrorDetail => ({ path: [...path], code, message });

const invalidCapabilityInput = (
  details: readonly CoreErrorDetail[],
): AssetResult<never> => ({
  ok: false,
  failure: coreFailure("invalid_request", "The capability input is invalid.", details),
});

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isStrictlySorted = (values: readonly string[]): boolean =>
  values.every((value, index) => index === 0 || codeUnitCompare(values[index - 1] ?? "", value) < 0);

const normalizeFeatureList = (
  value: unknown,
  path: readonly string[],
  details: CoreErrorDetail[],
  allowEmpty: boolean,
): CapabilityFeatureId[] | undefined => {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    details.push(detail(path, "invalid_feature_list", allowEmpty
      ? "The feature list must be an array."
      : "The feature list must contain at least one feature."));
    return undefined;
  }

  const features: CapabilityFeatureId[] = [];
  for (const [index, feature] of value.entries()) {
    if (!isNonEmptyString(feature)) {
      details.push(detail([...path, String(index)], "invalid_feature_id", "The capability feature id must not be empty."));
      continue;
    }
    features.push(feature as CapabilityFeatureId);
  }
  if (features.length !== value.length) return undefined;

  if (!isStrictlySorted(features)) {
    details.push(detail(path, "non_canonical_feature_list", "Feature ids must be sorted and unique."));
    return undefined;
  }
  return features;
};

const normalizeReference = (
  value: unknown,
  path: readonly string[],
  details: CoreErrorDetail[],
): CapabilityReference | undefined => {
  if (!isRecord(value) || !isNonEmptyString(value.capabilityId)) {
    details.push(detail([...path, "capabilityId"], "invalid_capability_id", "The capability id must not be empty."));
    return undefined;
  }

  if (!Object.hasOwn(value, "features") || value.features === undefined) {
    return { capabilityId: value.capabilityId as CapabilityId };
  }

  const features = normalizeFeatureList(value.features, [...path, "features"], details, false);
  return features === undefined
    ? undefined
    : { capabilityId: value.capabilityId as CapabilityId, features };
};

const referenceKey = (reference: CapabilityReference): string =>
  JSON.stringify([reference.capabilityId, reference.features === undefined ? null : reference.features]);

const normalizeDefinition = (
  value: unknown,
  path: readonly string[],
  details: CoreErrorDetail[],
): CapabilityDefinition | undefined => {
  if (!isRecord(value)) {
    details.push(detail(path, "invalid_definition", "The capability definition must be an object."));
    return undefined;
  }
  if (!isNonEmptyString(value.capabilityId)) {
    details.push(detail([...path, "capabilityId"], "invalid_capability_id", "The capability id must not be empty."));
  }
  if (!isNonEmptyString(value.displayName) || value.displayName.trim() === "") {
    details.push(detail([...path, "displayName"], "invalid_display_name", "The capability display name must not be empty."));
  }
  const features = normalizeFeatureList(value.features, [...path, "features"], details, true);
  if (!isNonEmptyString(value.capabilityId) || !isNonEmptyString(value.displayName) || value.displayName.trim() === "" || features === undefined) {
    return undefined;
  }
  return {
    capabilityId: value.capabilityId as CapabilityId,
    displayName: value.displayName,
    features,
  };
};

export const buildCapabilityCatalog = (
  definitions: readonly CapabilityDefinition[],
): AssetResult<CapabilityCatalog> => {
  const details: CoreErrorDetail[] = [];
  if (!Array.isArray(definitions)) {
    return invalidCapabilityInput([detail(["definitions"], "invalid_definitions", "Capability definitions must be an array.")]);
  }

  const normalizedDefinitions: CapabilityDefinition[] = [];
  const seenIds = new Set<string>();
  let previousId: string | undefined;
  for (const [index, definitionValue] of definitions.entries()) {
    const definition = normalizeDefinition(definitionValue, ["definitions", String(index)], details);
    if (definition === undefined) continue;

    if (seenIds.has(definition.capabilityId)) {
      details.push(detail(
        ["definitions", String(index), "capabilityId"],
        "duplicate_capability_id",
        `Capability id "${definition.capabilityId}" is declared more than once.`,
      ));
    } else {
      seenIds.add(definition.capabilityId);
    }
    if (previousId !== undefined && codeUnitCompare(previousId, definition.capabilityId) >= 0) {
      details.push(detail(
        ["definitions", String(index), "capabilityId"],
        "non_canonical_definition_order",
        "Capability definitions must be sorted by capability id.",
      ));
    }
    previousId = definition.capabilityId;
    normalizedDefinitions.push(definition);
  }

  if (details.length > 0) return invalidCapabilityInput(details);

  const catalog = new Map<CapabilityId, CapabilityDefinition>();
  for (const definition of normalizedDefinitions) catalog.set(definition.capabilityId, definition);
  return { ok: true, value: catalog };
};

const isMap = (value: unknown): value is ReadonlyMap<unknown, unknown> => value instanceof Map;

export const validateCapabilityContext = (
  context: CapabilityResolutionContext,
): AssetResult<CapabilityResolutionContext> => {
  const details: CoreErrorDetail[] = [];
  if (!isRecord(context) || !isMap(context.catalog)) {
    return invalidCapabilityInput([detail(["catalog"], "invalid_catalog", "The capability catalog must be a map.")]);
  }
  if (!Array.isArray(context.offers)) {
    return invalidCapabilityInput([detail(["offers"], "invalid_offers", "Capability offers must be an array.")]);
  }

  const catalog = new Map<CapabilityId, CapabilityDefinition>();
  let previousId: string | undefined;
  for (const [key, definitionValue] of context.catalog.entries()) {
    const definition = normalizeDefinition(definitionValue, ["catalog", String(key)], details);
    if (definition === undefined) continue;
    if (!isNonEmptyString(key) || key !== definition.capabilityId) {
      details.push(detail(
        ["catalog", String(key), "capabilityId"],
        "catalog_key_mismatch",
        "The catalog key must match the capability id.",
      ));
    }
    if (previousId !== undefined && isNonEmptyString(key) && codeUnitCompare(previousId, key) >= 0) {
      details.push(detail(["catalog", String(key)], "non_canonical_catalog_order", "The capability catalog must be sorted by capability id."));
    }
    if (isNonEmptyString(key)) previousId = key;
    catalog.set(definition.capabilityId, definition);
  }

  const offers: CapabilityOffer[] = [];
  const seenOffers = new Set<string>();
  for (const [index, offerValue] of context.offers.entries()) {
    if (!isRecord(offerValue) || !isNonEmptyString(offerValue.capabilityId)) {
      details.push(detail(["offers", String(index), "capabilityId"], "invalid_capability_id", "The capability id must not be empty."));
      continue;
    }
    const offerId = offerValue.capabilityId as CapabilityId;
    const permission = offerValue.permission;
    if (permission !== "allowed" && permission !== "denied") {
      details.push(detail(
        ["offers", String(index), "permission"],
        "invalid_capability_permission",
        "Capability offer permission must be allowed or denied.",
      ));
      continue;
    }
    const definition = catalog.get(offerId);
    if (definition === undefined) {
      details.push(detail(["offers", String(index), "capabilityId"], "unknown_capability_id", `Capability "${offerId}" is not declared in the catalog.`));
    }
    const features = normalizeFeatureList(offerValue.features, ["offers", String(index), "features"], details, true);
    if (features === undefined) continue;
    if (definition !== undefined && !featureSetContains(definition.features, features)) {
      details.push(detail(["offers", String(index), "features"], "unknown_capability_feature", `The offer features are not declared by capability "${offerId}".`));
    }
    const offerKey = JSON.stringify([offerId, features]);
    if (seenOffers.has(offerKey)) {
      details.push(detail(["offers", String(index)], "duplicate_capability_offer", `Capability offer "${offerId}" is declared more than once.`));
    } else {
      seenOffers.add(offerKey);
    }
    offers.push({ capabilityId: offerId, features, permission });
  }

  if (details.length > 0) return invalidCapabilityInput(details);
  return { ok: true, value: { catalog, offers } };
};

export const featureSetContains = (
  availableFeatures: readonly CapabilityFeatureId[],
  requiredFeatures: readonly CapabilityFeatureId[],
): boolean => requiredFeatures.every((feature) => availableFeatures.includes(feature));

const normalizeDependencies = (
  dependencies: unknown,
  catalog: CapabilityCatalog | undefined,
): AssetResult<readonly CapabilityDependency[]> => {
  const details: CoreErrorDetail[] = [];
  if (!Array.isArray(dependencies)) {
    return invalidCapabilityInput([detail(["dependencies"], "invalid_dependencies", "Capability dependencies must be an array.")]);
  }

  // A feature the matching definition does not declare can never be offered either —
  // validateCapabilityContext rejects such an offer — so the requirement is unsatisfiable
  // by construction.  Reporting it as a runtime absence would present invalid
  // configuration as a missing capability, hiding a misspelled feature id.
  const checkDeclaredFeatures = (
    reference: CapabilityReference | undefined,
    path: readonly string[],
  ): void => {
    if (catalog === undefined || reference?.features === undefined) return;
    // A capability absent from the catalog stays a runtime absence: the catalog carries
    // what this environment declares, not what a dependency is allowed to ask for.
    const definition = catalog.get(reference.capabilityId);
    if (definition === undefined || featureSetContains(definition.features, reference.features)) return;
    details.push(detail(
      path,
      "unknown_capability_feature",
      `Capability "${reference.capabilityId}" does not declare the requested features.`,
    ));
  };

  const normalized: CapabilityDependency[] = [];
  const primaryReferences = new Set<string>();
  const fallbackReferences = new Set<string>();
  for (const [index, dependencyValue] of dependencies.entries()) {
    const path = ["dependencies", String(index)];
    if (!isRecord(dependencyValue)) {
      details.push(detail(path, "invalid_dependency", "The capability dependency must be an object."));
      continue;
    }
    const capability = normalizeReference(dependencyValue.capability, [...path, "capability"], details);
    checkDeclaredFeatures(capability, [...path, "capability", "features"]);
    const strength = dependencyValue.strength;
    if (strength !== "required" && strength !== "optional" && strength !== "preferred" && strength !== "fallback") {
      details.push(detail([...path, "strength"], "invalid_dependency_strength", "The capability dependency strength is invalid."));
      continue;
    }
    const hasFallbackFor = Object.hasOwn(dependencyValue, "fallbackFor");
    if (strength === "fallback") {
      const fallbackFor = normalizeReference(dependencyValue.fallbackFor, [...path, "fallbackFor"], details);
      checkDeclaredFeatures(fallbackFor, [...path, "fallbackFor", "features"]);
      if (capability === undefined || fallbackFor === undefined) continue;
      const fallbackKey = referenceKey(fallbackFor);
      if (capability.capabilityId === fallbackFor.capabilityId
        && featureSetContains(capability.features ?? [], fallbackFor.features ?? [])) {
        // Availability is one predicate over an offer of that capability, so a fallback
        // demanding every feature its primary demands is unavailable whenever the primary
        // is — and satisfied only where the primary already was.  A weaker or disjoint
        // feature set on the same capability names a genuinely different offer and stays legal.
        details.push(detail(
          [...path, "capability"],
          "redundant_fallback",
          "A fallback on the same capability must not require every feature its primary requires.",
        ));
      }
      if (fallbackReferences.has(fallbackKey)) {
        details.push(detail([...path, "fallbackFor"], "duplicate_fallback", "A primary capability may have only one fallback."));
      } else {
        fallbackReferences.add(fallbackKey);
      }
      normalized.push({ strength, capability, fallbackFor });
    } else {
      if (hasFallbackFor) {
        details.push(detail([...path, "fallbackFor"], "unexpected_fallback_for", "Only fallback dependencies may declare fallbackFor."));
      }
      if (capability === undefined) continue;
      const primaryKey = referenceKey(capability);
      if (primaryReferences.has(primaryKey)) {
        details.push(detail([...path, "capability"], "duplicate_capability_dependency", "A capability reference may be declared only once."));
      } else {
        primaryReferences.add(primaryKey);
      }
      normalized.push({ strength, capability });
    }
  }

  for (const dependency of normalized) {
    if (dependency.strength !== "fallback") continue;
    if (!primaryReferences.has(referenceKey(dependency.fallbackFor))) {
      details.push(detail(
        ["dependencies"],
        "unknown_fallback_primary",
        `Fallback capability "${dependency.capability.capabilityId}" does not identify a declared primary dependency.`,
      ));
    }
  }
  if (details.length > 0) return invalidCapabilityInput(details);

  const ordered = [...normalized].sort((left, right) => {
    const leftRef = left.capability;
    const rightRef = right.capability;
    const idOrder = codeUnitCompare(leftRef.capabilityId, rightRef.capabilityId);
    if (idOrder !== 0) return idOrder;
    const leftFeatures = leftRef.features ?? [];
    const rightFeatures = rightRef.features ?? [];
    for (let index = 0; index < Math.max(leftFeatures.length, rightFeatures.length); index += 1) {
      const featureOrder = codeUnitCompare(leftFeatures[index] ?? "", rightFeatures[index] ?? "");
      if (featureOrder !== 0) return featureOrder;
    }
    const strengthOrder = codeUnitCompare(left.strength, right.strength);
    if (strengthOrder !== 0) return strengthOrder;
    if (left.strength === "fallback" && right.strength === "fallback") {
      return codeUnitCompare(referenceKey(left.fallbackFor), referenceKey(right.fallbackFor));
    }
    return 0;
  });
  return { ok: true, value: ordered };
};

const emptyContext = (): CapabilityResolutionContext => ({ catalog: new Map(), offers: [] });

type CapabilityUsability = "usable" | "denied" | "missing";

const capabilityAvailable = (
  reference: CapabilityReference,
  context: CapabilityResolutionContext,
): CapabilityUsability => {
  if (!context.catalog.has(reference.capabilityId)) return "missing";
  const matchingOffers = context.offers.filter((offer) =>
    offer.capabilityId === reference.capabilityId
    && featureSetContains(offer.features, reference.features ?? []));
  if (matchingOffers.length === 0) return "missing";
  return matchingOffers.some((offer) => offer.permission === "allowed") ? "usable" : "denied";
};

const capabilityReasonText = (
  capabilityId: CapabilityId,
  strength: CapabilityStrength,
  usability: CapabilityUsability,
  fallbackCapabilityId?: CapabilityId,
): string => {
  if (usability === "denied") {
    if (strength === "fallback") return `Fallback capability "${capabilityId}" is not permitted.`;
    if (fallbackCapabilityId !== undefined) {
      return `Fallback capability "${fallbackCapabilityId}" was selected because capability "${capabilityId}" with ${strength} strength is not permitted.`;
    }
    return `Capability "${capabilityId}" with ${strength} strength is not permitted.`;
  }
  if (strength === "fallback") return `Fallback capability "${capabilityId}" is unavailable.`;
  if (fallbackCapabilityId !== undefined) {
    return `Capability "${capabilityId}" with ${strength} strength is unavailable; fallback capability "${fallbackCapabilityId}" was selected.`;
  }
  return `Capability "${capabilityId}" with ${strength} strength is unavailable.`;
};

export const evaluateCapabilityDependencies = (
  dependencies: readonly CapabilityDependency[],
  context?: CapabilityResolutionContext,
): AssetResult<CapabilityDependencyOutcome> => {
  const contextResult = context === undefined ? { ok: true as const, value: emptyContext() } : validateCapabilityContext(context);
  const dependencyResult = normalizeDependencies(
    dependencies,
    contextResult.ok ? contextResult.value.catalog : undefined,
  );
  if (!dependencyResult.ok) {
    if (!contextResult.ok) return invalidCapabilityInput([
      ...(dependencyResult.failure.details ?? []),
      ...(contextResult.failure.details ?? []),
    ]);
    return dependencyResult;
  }
  if (!contextResult.ok) return contextResult;
  return evaluateNormalizedDependencies(dependencyResult.value, contextResult.value);
};

/**
 * Evaluate dependencies against a context that `validateCapabilityContext` has already
 * returned.  A caller resolving many dependency sets validates the context once and comes
 * here, instead of paying a full catalog and offer scan per set through the entry point
 * above.  Package-internal: the entry point is what an outside caller has.
 */
export const evaluateCapabilityDependenciesInValidatedContext = (
  dependencies: readonly CapabilityDependency[],
  validatedContext: CapabilityResolutionContext | undefined,
): AssetResult<CapabilityDependencyOutcome> => {
  const context = validatedContext ?? emptyContext();
  const dependencyResult = normalizeDependencies(dependencies, context.catalog);
  return dependencyResult.ok
    ? evaluateNormalizedDependencies(dependencyResult.value, context)
    : dependencyResult;
};

const evaluateNormalizedDependencies = (
  dependencies: readonly CapabilityDependency[],
  context: CapabilityResolutionContext,
): AssetResult<CapabilityDependencyOutcome> => {
  const primaryDependencies = dependencies.filter((dependency): dependency is Extract<CapabilityDependency, { strength: PrimaryCapabilityStrength }> => dependency.strength !== "fallback");
  const fallbackByPrimary = new Map<string, Extract<CapabilityDependency, { strength: "fallback" }>>();
  for (const dependency of dependencies) {
    if (dependency.strength === "fallback") fallbackByPrimary.set(referenceKey(dependency.fallbackFor), dependency);
  }

  const failedCapabilities: CapabilityId[] = [];
  const failureReasons: Array<{ readonly capabilityId: CapabilityId; readonly text: string }> = [];
  const failureKinds: CapabilityUsability[] = [];
  const degradations: CapabilityDegradation[] = [];
  const degradationReasons: Array<{ readonly capabilityId: CapabilityId; readonly text: string }> = [];
  for (const dependency of primaryDependencies) {
    const primaryUsability = capabilityAvailable(dependency.capability, context);
    if (primaryUsability === "usable") continue;

    const fallback = fallbackByPrimary.get(referenceKey(dependency.capability));
    const fallbackUsability = fallback === undefined
      ? undefined
      : capabilityAvailable(fallback.capability, context);
    if (fallbackUsability === "usable" && fallback !== undefined) {
      degradations.push({
        capabilityId: dependency.capability.capabilityId,
        strength: dependency.strength,
        fallbackCapabilityId: fallback.capability.capabilityId,
      });
      degradationReasons.push({
        capabilityId: dependency.capability.capabilityId,
        text: capabilityReasonText(
          dependency.capability.capabilityId,
          dependency.strength,
          primaryUsability,
          fallback.capability.capabilityId,
        ),
      });
      continue;
    }

    const primaryFailureReason = {
      capabilityId: dependency.capability.capabilityId,
      text: capabilityReasonText(dependency.capability.capabilityId, dependency.strength, primaryUsability),
    };
    const fallbackFailureReason = fallback === undefined ? undefined : {
      capabilityId: fallback!.capability.capabilityId,
      text: capabilityReasonText(fallback!.capability.capabilityId, "fallback", fallbackUsability!),
    };
    if (dependency.strength === "required") {
      failedCapabilities.push(dependency.capability.capabilityId);
      failureKinds.push(primaryUsability);
      failureReasons.push(primaryFailureReason);
      if (fallbackFailureReason !== undefined && fallback !== undefined) {
        failedCapabilities.push(fallback.capability.capabilityId);
        failureKinds.push(fallbackUsability!);
        failureReasons.push(fallbackFailureReason);
      }
    } else {
      degradations.push({
        capabilityId: dependency.capability.capabilityId,
        strength: dependency.strength,
      });
      degradationReasons.push(primaryFailureReason);
      if (fallbackFailureReason !== undefined) {
        degradationReasons.push(fallbackFailureReason);
      }
    }
  }

  // Several references to one capability differ only in their features, and neither the
  // exposed record nor the reason text carries a feature — so two such references
  // collapse to one indistinguishable entry rather than being reported twice.
  const canonicalReasons = (
    reasons: readonly { readonly capabilityId: CapabilityId; readonly text: string }[],
  ): string[] => [...new Set([...reasons]
    .sort((left, right) => codeUnitCompare(left.capabilityId, right.capabilityId))
    .map((reason) => reason.text))];

  // A required failure removes the candidate, so soft degradation cannot be retained alongside it.
  if (failedCapabilities.length > 0) {
    const uniqueFailedCapabilities = [...new Set(failedCapabilities)].sort(codeUnitCompare);
    // `kind` stays an ordinary enumerable field: the outcome is publicly re-exported, so a
    // consumer that spreads, clones, or serializes it would otherwise lose the discriminator
    // and turn a denial into an indistinguishable absence.
    return {
      ok: true,
      value: {
        ok: false,
        kind: failureKinds.includes("denied") ? "not_allowed" : "unavailable",
        failedCapabilities: uniqueFailedCapabilities,
        reasons: canonicalReasons(failureReasons),
      },
    };
  }
  if (degradations.length === 0) return { ok: true, value: { ok: true } };
  const degradationKey = (degradation: CapabilityDegradation): string =>
    JSON.stringify([degradation.capabilityId, degradation.strength, degradation.fallbackCapabilityId ?? null]);
  const uniqueDegradations: CapabilityDegradation[] = [];
  const seenDegradations = new Set<string>();
  for (const degradation of [...degradations].sort((left, right) => codeUnitCompare(degradationKey(left), degradationKey(right)))) {
    const key = degradationKey(degradation);
    if (seenDegradations.has(key)) continue;
    seenDegradations.add(key);
    uniqueDegradations.push(degradation);
  }
  return {
    ok: true,
    value: {
      ok: true,
      degradation: { reasons: canonicalReasons(degradationReasons) },
      degradedCapabilities: uniqueDegradations,
    },
  };
};
