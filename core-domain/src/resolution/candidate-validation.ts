import { ASSET_TYPES, LOADING_TIERS } from "@aacl/shared";
import type { AssetType, CoreErrorDetail, LoadingTier, ResolutionScopeInput } from "@aacl/shared";
import { DEFAULT_ASSET_TYPE_CONTRACTS } from "./asset-type-contracts.ts";
import type { AssetOperationKind, AssetTypeContract, AssetTypeContractRegistry } from "./asset-type-contracts.ts";
import { evaluateCapabilityDependenciesInValidatedContext, validateCapabilityContext } from "../capabilities/dependencies.ts";
import type { CapabilityDependency, CapabilityResolutionContext, CapabilityId } from "../capabilities/dependencies.ts";
import { coreFailure, type AssetResult } from "../failures.ts";
import { normalizeResolutionDirectory, RESOLUTION_AXES, type NormalizedDirectory, type ResolutionAxis, type ResolutionContext, toResolutionContext } from "./resolution-context.ts";
import { codeUnitCompare } from "../ordering.ts";
import type { AssetCandidate, CandidateReason, CandidateRecord, CandidateState, NormalizedCandidate, ResolutionOperation, ResolutionRule, ResolveScopeInput } from "./resolution-types.ts";
import { sourceLayerPrecedence } from "./ranking-precedence.ts";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export const compareStringLists = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);


export const sameOperation = (left: ResolutionOperation, right: ResolutionOperation): boolean =>
  left.kind === right.kind && (left.kind === "add" || right.kind === "add" || left.targetAssetId === right.targetAssetId);

export const capabilityReferenceKey = (reference: { readonly capabilityId: CapabilityId; readonly features?: readonly string[] }): string =>
  JSON.stringify([reference.capabilityId, reference.features === undefined ? null : reference.features]);

export const capabilityDependencyKey = (dependency: CapabilityDependency): string =>
  dependency.strength === "fallback"
    ? `${dependency.strength}\u0000${capabilityReferenceKey(dependency.capability)}\u0000${capabilityReferenceKey(dependency.fallbackFor)}`
    : `${dependency.strength}\u0000${capabilityReferenceKey(dependency.capability)}`;

export const canonicalCapabilityDependencyKeys = (
  dependencies: readonly CapabilityDependency[] | undefined,
): readonly string[] => (dependencies ?? []).map(capabilityDependencyKey).sort(codeUnitCompare);

export const sameStringLists = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

export const sameCandidateMeaning = (
  left: NormalizedCandidate,
  right: NormalizedCandidate,
): boolean => {
  if (left.candidate.assetId !== right.candidate.assetId || left.candidate.revision !== right.candidate.revision) return false;
  const leftRule = left.candidate.rule;
  const rightRule = right.candidate.rule;
  if (leftRule.mandatory !== rightRule.mandatory || !sameOperation(leftRule.operation, rightRule.operation)) return false;
  if (leftRule.explicitPriority !== rightRule.explicitPriority || leftRule.mergeMode !== rightRule.mergeMode) return false;
  if (leftRule.mergeGroup !== rightRule.mergeGroup || !compareStringLists(leftRule.requires, rightRule.requires)) return false;
  if (!sameStringLists(
    canonicalCapabilityDependencyKeys(leftRule.capabilityDependencies),
    canonicalCapabilityDependencyKeys(rightRule.capabilityDependencies),
  )) return false;
  for (const axis of RESOLUTION_AXES) {
    const leftHas = Object.prototype.hasOwnProperty.call(leftRule.selectors, axis);
    const rightHas = Object.prototype.hasOwnProperty.call(rightRule.selectors, axis);
    if (leftHas !== rightHas) return false;
    if (leftHas && !compareStringLists(leftRule.selectors[axis] ?? [], rightRule.selectors[axis] ?? [])) return false;
  }
  return true;
};

export const chooseCanonicalDuplicateRepresentative = (
  candidates: readonly NormalizedCandidate[],
): NormalizedCandidate => {
  const first = candidates[0];
  if (first === undefined) throw new Error("Cannot choose a representative from an empty candidate list.");
  return candidates.slice(1).reduce((best, current) => {
    const layerOrder = sourceLayerPrecedence(current.candidate.source.layer) - sourceLayerPrecedence(best.candidate.source.layer);
    if (layerOrder < 0) return best;
    if (layerOrder > 0) return current;
    return codeUnitCompare(current.candidate.source.sourceId, best.candidate.source.sourceId) < 0 ? current : best;
  }, first);
};

export const deduplicateExactCandidates = (
  candidates: readonly NormalizedCandidate[],
): readonly NormalizedCandidate[] => {
  const groupsByIdentity = new Map<string, NormalizedCandidate[][]>();
  for (const candidate of candidates) {
    const identity = `${String(candidate.candidate.assetId)}\u0000${String(candidate.candidate.revision)}`;
    const groups = groupsByIdentity.get(identity) ?? [];
    const group = groups.find((items) => sameCandidateMeaning(items[0] as NormalizedCandidate, candidate));
    if (group === undefined) groups.push([candidate]);
    else group.push(candidate);
    groupsByIdentity.set(identity, groups);
  }
  return [...groupsByIdentity.values()].flat().map(chooseCanonicalDuplicateRepresentative);
};

export const detail = (path: readonly string[], code: string, message: string): CoreErrorDetail => ({
  path: [...path],
  code,
  message,
});

export const invalidRequest = (details: readonly CoreErrorDetail[]): AssetResult<never> => ({
  ok: false,
  failure: coreFailure("invalid_request", "The resolution input is invalid.", details),
});

export const candidatePath = (candidate: AssetCandidate, ...parts: string[]): string[] => [
  "snapshot",
  "candidate",
  isNonEmptyString(isRecord(candidate) ? candidate.assetId : undefined)
    ? (candidate as unknown as Record<string, unknown>).assetId as string
    : "",
  ...parts,
];

export const invalidDirectoryReason = (diagnostics: readonly CoreErrorDetail[]): CandidateReason => ({
  kind: "excluded",
  cause: "invalid_directory",
  diagnostics,
});

export const normalizeCandidateDirectory = (
  candidate: AssetCandidate,
): { readonly candidate?: NormalizedCandidate; readonly diagnostics?: readonly CoreErrorDetail[] } => {
  const candidateValue: Record<string, unknown> = isRecord(candidate) ? candidate : {};
  const ruleValue = candidateValue.rule;
  const selectorsValue = isRecord(ruleValue) ? ruleValue.selectors : undefined;
  if (!isRecord(selectorsValue)) return { candidate: { candidate } };
  const directory = selectorsValue.directory;
  if (directory === undefined) return { candidate: { candidate } };

  const path = candidatePath(candidate, "rule", "selectors", "directory");
  if (!Array.isArray(directory)) {
    return { diagnostics: [detail(path, "invalid_directory", "The directory selector must be a list.")] };
  }
  if (directory.length === 0) return { diagnostics: [detail(path, "empty_list", "The directory selector must not be empty.")] };

  const normalized: NormalizedDirectory[] = [];
  const diagnostics: CoreErrorDetail[] = [];
  for (const value of directory) {
    const result = normalizeResolutionDirectory(value, path);
    if (!result.ok) diagnostics.push(...(result.failure.details ?? []));
    else normalized.push(result.value);
  }
  if (diagnostics.length > 0) return { diagnostics };

  // Re-sorted and de-duplicated after normalization, not before: normalizing does not
  // preserve either property. The parser stores selectors in ascending code-unit order,
  // and `-` (0x2D) sorts before `/` (0x2F), so dropping a trailing slash turns
  // ["/repo/src-extra", "/repo/src/"] into a descending pair; two spellings of one
  // directory likewise only collide once both are normalized.
  const values = [...new Map(normalized.map((item) => [item.value, item])).values()]
    .sort((left, right) => codeUnitCompare(left.value, right.value));
  const normalizedSelectors: Partial<Record<ResolutionAxis, readonly string[]>> = {
    ...(selectorsValue as Partial<Record<ResolutionAxis, readonly string[]>>),
    directory: values.map((item) => item.value),
  };
  const normalizedRule = {
    ...(ruleValue as ResolutionRule),
    selectors: normalizedSelectors,
  } as ResolutionRule;
  return { candidate: { candidate: { ...candidate, rule: normalizedRule } } };
};

export const validateStringList = (
  value: unknown,
  path: readonly string[],
  details: CoreErrorDetail[],
  allowEmpty: boolean,
): value is readonly string[] => {
  if (!Array.isArray(value)) {
    details.push(detail(path, "invalid_value", "The value must be a list of non-empty strings."));
    return false;
  }
  if (value.some((item) => item === "")) {
    details.push(detail(path, "empty_identifier", "The list must not contain empty strings."));
    return false;
  }
  if (value.some((item) => !isNonEmptyString(item))) {
    details.push(detail(path, "invalid_value", "The value must be a list of non-empty strings."));
    return false;
  }
  if (!allowEmpty && value.length === 0) details.push(detail(path, "empty_list", "The list must not be empty."));
  if (new Set(value).size !== value.length) details.push(detail(path, "duplicate_value", "The list must not contain duplicates."));
  if (value.some((item, index) => index > 0 && codeUnitCompare(value[index - 1] as string, item) >= 0)) {
    details.push(detail(path, "invalid_value", "The list must be code-unit sorted and unique."));
  }
  return true;
};

export const validateCandidate = (
  candidate: NormalizedCandidate,
  contracts: AssetTypeContractRegistry,
  capabilityContext: CapabilityResolutionContext | undefined,
): readonly CoreErrorDetail[] => {
  const details: CoreErrorDetail[] = [];
  const value = candidate.candidate as unknown as Record<string, unknown>;
  const path = candidatePath(candidate.candidate);
  if (!isRecord(value)) return [detail(path, "invalid_value", "The candidate must be an object.")];
  if (!isNonEmptyString(value.assetId)) details.push(detail([...path, "assetId"], "empty_identifier", "The asset id must not be empty."));
  if (!isNonEmptyString(value.revision)) details.push(detail([...path, "revision"], "empty_identifier", "The revision must not be empty."));
  const assetTypeIsKnown =
    isNonEmptyString(value.assetType) && ASSET_TYPES.includes(value.assetType as AssetType);
  if (!assetTypeIsKnown) {
    details.push(detail([...path, "assetType"], "invalid_value", "The asset type is invalid."));
  }
  if (!isNonEmptyString(value.loadingTier) || !LOADING_TIERS.includes(value.loadingTier as LoadingTier)) {
    details.push(detail([...path, "loadingTier"], "invalid_value", "The loading tier is invalid."));
  }

  const source = value.source;
  if (!isRecord(source)) {
    details.push(detail([...path, "source"], "invalid_value", "The source must be an object."));
  } else {
    if (source.layer !== "global" && source.layer !== "personal" && source.layer !== "project") {
      details.push(detail([...path, "source", "layer"], "invalid_value", "The source layer is invalid."));
    }
    if (!isNonEmptyString(source.sourceId)) details.push(detail([...path, "source", "sourceId"], "empty_identifier", "The source id must not be empty."));
  }

  const rule = value.rule;
  if (!isRecord(rule)) {
    details.push(detail([...path, "rule"], "invalid_value", "The rule must be an object."));
    return details;
  }
  if (typeof rule.mandatory !== "boolean") details.push(detail([...path, "rule", "mandatory"], "invalid_value", "Mandatory must be a boolean."));
  if (rule.explicitPriority !== undefined && (
    typeof rule.explicitPriority !== "number" ||
    !Number.isSafeInteger(rule.explicitPriority) ||
    rule.explicitPriority < 0
  )) {
    details.push(detail([...path, "rule", "explicitPriority"], "invalid_value", "Priority must be a non-negative safe integer."));
  }
  if (!Array.isArray(rule.requires)) details.push(detail([...path, "rule", "requires"], "invalid_value", "Requires must be a list."));
  else validateStringList(rule.requires, [...path, "rule", "requires"], details, true);

  const capabilityDependencies = rule.capabilityDependencies;
  if (capabilityDependencies !== undefined) {
    // The catalog is passed here, not only where the included candidates are evaluated:
    // a dependency naming a feature its definition does not declare is invalid
    // configuration of the snapshot, and scope decides which candidates apply — not
    // which ones are well-formed.
    const capabilityResult = evaluateCapabilityDependenciesInValidatedContext(
      capabilityDependencies as unknown as readonly CapabilityDependency[],
      capabilityContext,
    );
    if (!capabilityResult.ok) {
      for (const capabilityDetail of capabilityResult.failure.details ?? []) {
        const relativePath = capabilityDetail.path[0] === "dependencies"
          ? capabilityDetail.path.slice(1)
          : capabilityDetail.path;
        details.push(detail(
          [...path, "rule", "capabilityDependencies", ...relativePath],
          capabilityDetail.code,
          capabilityDetail.message,
        ));
      }
    }
  }

  const selectors = rule.selectors;
  if (!isRecord(selectors)) {
    details.push(detail([...path, "rule", "selectors"], "invalid_value", "Selectors must be an object."));
  } else {
    for (const key of Object.keys(selectors)) {
      if (!RESOLUTION_AXES.includes(key as ResolutionAxis)) {
        details.push(detail([...path, "rule", "selectors", key], "unknown_key", `Unknown selector axis "${key}".`));
        continue;
      }
      if (key === "directory") continue;
      validateStringList(selectors[key], [...path, "rule", "selectors", key], details, false);
    }
  }

  const operation = rule.operation;
  if (!isRecord(operation) || (operation.kind !== "add" && operation.kind !== "override" && operation.kind !== "disable")) {
    details.push(detail([...path, "rule", "operation"], "invalid_value", "The operation is invalid."));
  } else if (operation.kind !== "add" && !isNonEmptyString(operation.targetAssetId)) {
    details.push(detail([...path, "rule", "operation", "targetAssetId"], "empty_identifier", "The target asset id must not be empty."));
  }

  if (rule.mergeMode !== "additive" && rule.mergeMode !== "exclusive") {
    details.push(detail([...path, "rule", "mergeMode"], "invalid_value", "The merge mode is invalid."));
  } else if (rule.mergeMode === "exclusive" && !isNonEmptyString(rule.mergeGroup)) {
    details.push(detail([...path, "rule", "mergeGroup"], "invalid_merge_group", "An exclusive merge group is required."));
  } else if (rule.mergeMode === "additive" && rule.mergeGroup !== undefined && !isNonEmptyString(rule.mergeGroup)) {
    details.push(detail([...path, "rule", "mergeGroup"], "invalid_merge_group", "The merge group must not be empty."));
  }
  // Skipped for an unknown asset type: the membership failure above is already
  // recorded, and a contract lookup on an unknown key has nothing to read.
  if (assetTypeIsKnown) {
    const contract: AssetTypeContract = contracts[value.assetType as AssetType];
    const operation = rule.operation;
    if (isRecord(operation) && isNonEmptyString(operation.kind) &&
        !contract.allowedOperationKinds.includes(operation.kind as AssetOperationKind)) {
      details.push(detail(
        [...path, "rule", "operation", "kind"],
        "operation_not_allowed",
        "The asset type does not allow this operation.",
      ));
    }
    if (rule.mergeMode === "exclusive" && !contract.mergePolicy.allowsExclusive) {
      details.push(detail(
        [...path, "rule", "mergeMode"],
        "merge_mode_not_allowed",
        "The asset type does not allow an exclusive merge.",
      ));
    }
    if (Array.isArray(capabilityDependencies) && capabilityDependencies.length > 0 && !contract.allowsCapabilityDependencies) {
      details.push(detail(
        [...path, "rule", "capabilityDependencies"],
        "capability_dependencies_not_allowed",
        "The asset type does not allow capability dependencies.",
      ));
    }
  }
  return details;
};


export const toResolutionContextSafely = (
  scope: unknown,
): AssetResult<ResolutionContext> => {
  if (!isRecord(scope)) return invalidRequest([detail(["scope"], "invalid_value", "The resolution scope must be an object.")]);
  const input = scope as ResolutionScopeInput;
  return toResolutionContext(input);
};

export type ValidatedResolutionInput = {
  readonly context: ResolutionContext;
  readonly capabilityContext: CapabilityResolutionContext | undefined;
  readonly invalidStates: CandidateState[];
  readonly deduplicated: readonly NormalizedCandidate[];
};

export const validateResolutionInput = (
  input: ResolveScopeInput,
): AssetResult<ValidatedResolutionInput> => {
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
  return {
    ok: true,
    value: {
      context: contextResult.value,
      ...(capabilityContext === undefined ? {} : { capabilityContext }),
      invalidStates,
      deduplicated,
    } as ValidatedResolutionInput,
  };
};
