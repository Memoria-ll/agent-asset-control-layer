import { ASSET_TYPES, LOADING_TIERS } from "@aacl/shared";
import type {
  AssetId,
  AssetRevision,
  AssetType,
  ConflictDto,
  CoreErrorDetail,
  LoadingTier,
  ResolutionReason,
  ResolutionScopeInput,
} from "@aacl/shared";
import { coreFailure, type AssetResult } from "./failures.ts";
import {
  normalizeResolutionDirectory,
  RESOLUTION_AXES,
  type NormalizedDirectory,
  type ResolutionAxis,
  type ResolutionContext,
  toResolutionContext,
} from "./resolution-context.ts";
import { codeUnitCompare } from "./ordering.ts";

export type ResolutionSourceLayer = "global" | "personal" | "project";

export type ResolutionSource = {
  readonly layer: ResolutionSourceLayer;
  readonly sourceId: string;
};

export type ResolutionOperation =
  | { readonly kind: "add" }
  | { readonly kind: "override"; readonly targetAssetId: AssetId }
  | { readonly kind: "disable"; readonly targetAssetId: AssetId };

export type ResolutionMerge =
  | { readonly mergeMode: "additive"; readonly mergeGroup?: string }
  | { readonly mergeMode: "exclusive"; readonly mergeGroup: string };

export type ResolutionRule = {
  readonly selectors: Readonly<Partial<Record<ResolutionAxis, readonly string[]>>>;
  readonly mandatory: boolean;
  readonly operation: ResolutionOperation;
  readonly explicitPriority?: number;
  readonly requires: readonly AssetId[];
} & ResolutionMerge;

export type AssetCandidate = {
  readonly assetId: AssetId;
  readonly revision: AssetRevision;
  readonly assetType: AssetType;
  readonly loadingTier: LoadingTier;
  readonly source: ResolutionSource;
  readonly rule: ResolutionRule;
};

export type ResolutionSnapshot = {
  readonly candidates: readonly AssetCandidate[];
};

type NormalizedCandidate = {
  readonly candidate: AssetCandidate;
};

type MatchedCandidate = NormalizedCandidate & {
  readonly matchedAxes: readonly ResolutionAxis[];
  readonly rank: ResolutionRank;
};

type ScopeMatchDecision =
  | {
      readonly matched: true;
      readonly matchedAxes: readonly ResolutionAxis[];
      readonly rank: ResolutionRank;
    }
  | {
      readonly matched: false;
      readonly mismatchedAxes: readonly ResolutionAxis[];
    };

type ExclusiveDecision =
  | { readonly kind: "winner"; readonly candidate: MatchedCandidate }
  | { readonly kind: "conflict"; readonly conflict: ResolutionConflict };

export type ResolutionRank = {
  readonly sourcePrecedence: 0 | 1 | 2;
  readonly explicitPriority: number;
  readonly matchingAxisCount: number;
  readonly directoryDepth: number;
};

export type CandidateReason =
  | {
      readonly kind: "included";
      readonly matchedAxes: readonly ResolutionAxis[];
      readonly rank: ResolutionRank;
    }
  | {
      readonly kind: "excluded";
      readonly cause: "scope_mismatch";
      readonly mismatchedAxes: readonly ResolutionAxis[];
    }
  | {
      readonly kind: "excluded";
      readonly cause: "invalid_directory";
      readonly diagnostics: readonly CoreErrorDetail[];
    }
  | {
      readonly kind: "excluded";
      readonly cause: "resolution_conflict";
      readonly conflict: ResolutionConflict;
      readonly rank?: ResolutionRank;
    }
  | {
      readonly kind: "overridden";
      readonly overriddenBy: AssetId;
      readonly mergeGroup: string;
      readonly winnerRank: ResolutionRank;
    }
  | {
      readonly kind: "disabled";
      readonly disabledBy: AssetId;
    }
  | {
      readonly kind: "unavailable";
      readonly availability: "degraded" | "unavailable";
      readonly cause:
        | "missing_requirement"
        | "requirement_out_of_scope"
        | "requirement_disabled"
        | "requirement_overridden"
        | "requirement_cycle"
        | "requirement_invalid";
      readonly failedRequirements: readonly AssetId[];
    };

export type ResolutionConflict =
  | {
      readonly kind: "exclusive_tie";
      readonly mergeGroup: string;
      readonly involvedAssetIds: readonly AssetId[];
    }
  | {
      readonly kind: "mandatory_conflict";
      readonly involvedAssetIds: readonly AssetId[];
    }
  | {
      readonly kind: "operation_conflict";
      readonly targetAssetId: AssetId;
      readonly involvedAssetIds: readonly AssetId[];
    }
  | {
      readonly kind: "duplicate_identity";
      readonly assetId: AssetId;
      readonly involvedAssetIds: readonly AssetId[];
    }
  | {
      readonly kind: "dependency_cycle";
      readonly involvedAssetIds: readonly AssetId[];
    }
  | {
      readonly kind: "dependency_failure";
      readonly failedRequirement: AssetId;
      readonly involvedAssetIds: readonly AssetId[];
    };

export type ResolveScopeInput = {
  readonly scope: ResolutionScopeInput;
  readonly snapshot: ResolutionSnapshot;
};

export type ResolutionEvaluation = {
  readonly candidate: AssetCandidate;
  readonly reason: CandidateReason;
};

export type ResolutionResult = {
  readonly scope: ResolutionContext;
  readonly evaluations: readonly ResolutionEvaluation[];
  readonly outcome: "resolved" | "conflicted";
  readonly conflicts: readonly ResolutionConflict[];
};

type CandidateState = {
  readonly candidate: AssetCandidate;
  matched: boolean;
  reason: CandidateReason;
  rank?: ResolutionRank;
};

type DependencyCause =
  | "missing_requirement"
  | "requirement_out_of_scope"
  | "requirement_disabled"
  | "requirement_overridden"
  | "requirement_cycle"
  | "requirement_invalid";

type DependencyOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly cause: DependencyCause;
      readonly failedRequirements: readonly AssetId[];
      readonly cycleIds?: readonly AssetId[];
    };

/**
 * The more specific layer wins, so a personal asset overrides a global one.
 *
 * Ranking a global asset above a personal one is not the way a global asset is
 * protected: `mandatory` is. Layer order decides which of two interchangeable
 * candidates is preferred; a global asset that must survive a personal override
 * declares itself mandatory, and the hard rule then holds regardless of rank.
 */
const sourcePrecedence = (layer: ResolutionSourceLayer): 0 | 1 | 2 => {
  switch (layer) {
    case "global": return 0;
    case "personal": return 1;
    case "project": return 2;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const compareStringLists = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const sortedUniqueIds = (ids: readonly AssetId[]): readonly AssetId[] =>
  [...new Set(ids)].sort(codeUnitCompare);

const conflictKey = (conflict: ResolutionConflict): string => {
  switch (conflict.kind) {
    case "exclusive_tie": return `${conflict.kind}:${conflict.mergeGroup}:${conflict.involvedAssetIds.join("\u0000")}`;
    case "operation_conflict": return `${conflict.kind}:${conflict.targetAssetId}:${conflict.involvedAssetIds.join("\u0000")}`;
    case "duplicate_identity": return `${conflict.kind}:${conflict.assetId}:${conflict.involvedAssetIds.join("\u0000")}`;
    case "dependency_failure": return `${conflict.kind}:${conflict.failedRequirement}:${conflict.involvedAssetIds.join("\u0000")}`;
    default: return `${conflict.kind}:${conflict.involvedAssetIds.join("\u0000")}`;
  }
};

const canonicalIds = (ids: readonly AssetId[]): readonly AssetId[] => sortedUniqueIds(ids);

const sameOperation = (left: ResolutionOperation, right: ResolutionOperation): boolean =>
  left.kind === right.kind && (left.kind === "add" || right.kind === "add" || left.targetAssetId === right.targetAssetId);

const sameCandidateMeaning = (
  left: NormalizedCandidate,
  right: NormalizedCandidate,
): boolean => {
  if (left.candidate.assetId !== right.candidate.assetId || left.candidate.revision !== right.candidate.revision) return false;
  const leftRule = left.candidate.rule;
  const rightRule = right.candidate.rule;
  if (leftRule.mandatory !== rightRule.mandatory || !sameOperation(leftRule.operation, rightRule.operation)) return false;
  if (leftRule.explicitPriority !== rightRule.explicitPriority || leftRule.mergeMode !== rightRule.mergeMode) return false;
  if (leftRule.mergeGroup !== rightRule.mergeGroup || !compareStringLists(leftRule.requires, rightRule.requires)) return false;
  for (const axis of RESOLUTION_AXES) {
    const leftHas = Object.prototype.hasOwnProperty.call(leftRule.selectors, axis);
    const rightHas = Object.prototype.hasOwnProperty.call(rightRule.selectors, axis);
    if (leftHas !== rightHas) return false;
    if (leftHas && !compareStringLists(leftRule.selectors[axis] ?? [], rightRule.selectors[axis] ?? [])) return false;
  }
  return true;
};

const chooseCanonicalDuplicateRepresentative = (
  candidates: readonly NormalizedCandidate[],
): NormalizedCandidate => {
  const first = candidates[0];
  if (first === undefined) throw new Error("Cannot choose a representative from an empty candidate list.");
  return candidates.slice(1).reduce((best, current) => {
    const layerOrder = sourcePrecedence(current.candidate.source.layer) - sourcePrecedence(best.candidate.source.layer);
    if (layerOrder < 0) return best;
    if (layerOrder > 0) return current;
    return codeUnitCompare(current.candidate.source.sourceId, best.candidate.source.sourceId) < 0 ? current : best;
  }, first);
};

const deduplicateExactCandidates = (
  candidates: readonly NormalizedCandidate[],
): readonly NormalizedCandidate[] => {
  const groups: NormalizedCandidate[][] = [];
  for (const candidate of candidates) {
    const group = groups.find((items) => sameCandidateMeaning(items[0] as NormalizedCandidate, candidate));
    if (group === undefined) groups.push([candidate]);
    else group.push(candidate);
  }
  return groups.map(chooseCanonicalDuplicateRepresentative);
};

const isSameIdOverlayPair = (
  issuer: CandidateState,
  target: CandidateState,
): boolean => {
  const operation = issuer.candidate.rule.operation;
  return operation.kind !== "add" &&
    operation.targetAssetId === issuer.candidate.assetId &&
    target.candidate.assetId === issuer.candidate.assetId &&
    target.candidate.source.layer !== issuer.candidate.source.layer &&
    sourcePrecedence(target.candidate.source.layer) < sourcePrecedence(issuer.candidate.source.layer);
};

const hasUnresolvedIdentityPair = (
  group: readonly CandidateState[],
): boolean => group.some((left, leftIndex) =>
  group.slice(leftIndex + 1).some((right) =>
    !isSameIdOverlayPair(left, right) && !isSameIdOverlayPair(right, left)));

const compareResolutionRank = (left: ResolutionRank, right: ResolutionRank): number => {
  if (left.sourcePrecedence !== right.sourcePrecedence) return left.sourcePrecedence - right.sourcePrecedence;
  if (left.explicitPriority !== right.explicitPriority) return left.explicitPriority - right.explicitPriority;
  if (left.matchingAxisCount !== right.matchingAxisCount) return left.matchingAxisCount - right.matchingAxisCount;
  return left.directoryDepth - right.directoryDepth;
};

const sameResolutionRank = (left: ResolutionRank, right: ResolutionRank): boolean =>
  left.sourcePrecedence === right.sourcePrecedence &&
  left.explicitPriority === right.explicitPriority &&
  left.matchingAxisCount === right.matchingAxisCount &&
  left.directoryDepth === right.directoryDepth;

const directorySegments = (value: string): readonly string[] => value === "/" ? [] : value.slice(1).split("/");

const directoryMatches = (
  candidateSegments: readonly string[],
  requestSegments: readonly string[],
): boolean =>
  candidateSegments.length <= requestSegments.length &&
  candidateSegments.every((segment, index) => segment === requestSegments[index]);

const matchesScope = (
  candidate: NormalizedCandidate,
  context: ResolutionContext,
): ScopeMatchDecision => {
  const mismatchedAxes: ResolutionAxis[] = [];
  const matchedAxes: ResolutionAxis[] = [];
  let matchingAxisCount = 0;
  let directoryDepth = 0;

  for (const axis of RESOLUTION_AXES) {
    const requestValue = context[axis];
    if (requestValue === undefined) continue;
    const selectors = candidate.candidate.rule.selectors[axis];
    if (selectors === undefined) continue;

    if (axis === "directory") {
      const requestSegments = directorySegments(requestValue);
      const matchedSelector = selectors
        .map(directorySegments)
        .filter((segments) => directoryMatches(segments, requestSegments))
        .sort((left, right) => right.length - left.length)[0];
      if (matchedSelector === undefined) mismatchedAxes.push(axis);
      else {
        matchedAxes.push(axis);
        directoryDepth = matchedSelector.length;
      }
      continue;
    }

    if (!selectors.includes(requestValue)) mismatchedAxes.push(axis);
    else {
      matchedAxes.push(axis);
      matchingAxisCount += 1;
    }
  }

  if (mismatchedAxes.length > 0) return { matched: false, mismatchedAxes };
  return {
    matched: true,
    matchedAxes,
    rank: {
      sourcePrecedence: sourcePrecedence(candidate.candidate.source.layer),
      explicitPriority: candidate.candidate.rule.explicitPriority ?? -1,
      matchingAxisCount,
      directoryDepth,
    },
  };
};

const selectExclusiveWinner = (candidates: readonly MatchedCandidate[]): ExclusiveDecision => {
  const first = candidates[0];
  if (first === undefined) throw new Error("Cannot select an exclusive winner from an empty group.");
  const bestRank = candidates.reduce((best, current) =>
    compareResolutionRank(current.rank, best) > 0 ? current.rank : best, first.rank);
  const tied = candidates.filter((candidate) => sameResolutionRank(candidate.rank, bestRank));
  if (tied.length === 1) return { kind: "winner", candidate: tied[0] as MatchedCandidate };
  const sameMeaning = tied.every((candidate) => sameCandidateMeaning(first, candidate));
  if (sameMeaning) return { kind: "winner", candidate: tied[0] as MatchedCandidate };
  return {
    kind: "conflict",
    conflict: {
      kind: "exclusive_tie",
      mergeGroup: first.candidate.rule.mergeGroup as string,
      involvedAssetIds: canonicalIds(tied.map((candidate) => candidate.candidate.assetId)),
    },
  };
};

const detail = (path: readonly string[], code: string, message: string): CoreErrorDetail => ({
  path: [...path],
  code,
  message,
});

const invalidRequest = (details: readonly CoreErrorDetail[]): AssetResult<never> => ({
  ok: false,
  failure: coreFailure("invalid_request", "The resolution input is invalid.", details),
});

const candidatePath = (candidate: AssetCandidate, ...parts: string[]): string[] => [
  "snapshot",
  "candidate",
  isNonEmptyString(isRecord(candidate) ? candidate.assetId : undefined)
    ? (candidate as unknown as Record<string, unknown>).assetId as string
    : "",
  ...parts,
];

const invalidDirectoryReason = (diagnostics: readonly CoreErrorDetail[]): CandidateReason => ({
  kind: "excluded",
  cause: "invalid_directory",
  diagnostics,
});

const normalizeCandidateDirectory = (
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

const validateStringList = (
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

const validateCandidate = (candidate: NormalizedCandidate): readonly CoreErrorDetail[] => {
  const details: CoreErrorDetail[] = [];
  const value = candidate.candidate as unknown as Record<string, unknown>;
  const path = candidatePath(candidate.candidate);
  if (!isRecord(value)) return [detail(path, "invalid_value", "The candidate must be an object.")];
  if (!isNonEmptyString(value.assetId)) details.push(detail([...path, "assetId"], "empty_identifier", "The asset id must not be empty."));
  if (!isNonEmptyString(value.revision)) details.push(detail([...path, "revision"], "empty_identifier", "The revision must not be empty."));
  if (!isNonEmptyString(value.assetType) || !ASSET_TYPES.includes(value.assetType as AssetType)) {
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
  return details;
};

const resolutionConflictReason = (conflict: ResolutionConflict, rank?: ResolutionRank): CandidateReason => ({
  kind: "excluded",
  cause: "resolution_conflict",
  conflict,
  ...(rank === undefined ? {} : { rank }),
});

const compareCandidatesForOutput = (left: CandidateState, right: CandidateState): number => {
  if (left.rank !== undefined && right.rank === undefined) return -1;
  if (left.rank === undefined && right.rank !== undefined) return 1;
  if (left.rank !== undefined && right.rank !== undefined) {
    const rankOrder = compareResolutionRank(right.rank, left.rank);
    if (rankOrder !== 0) return rankOrder;
  }
  const assetOrder = codeUnitCompare(String(left.candidate.assetId), String(right.candidate.assetId));
  if (assetOrder !== 0) return assetOrder;
  const revisionOrder = codeUnitCompare(String(left.candidate.revision), String(right.candidate.revision));
  if (revisionOrder !== 0) return revisionOrder;
  const sourceOrder = codeUnitCompare(String(left.candidate.source.sourceId), String(right.candidate.source.sourceId));
  if (sourceOrder !== 0) return sourceOrder;

  const leftCandidate = left.candidate;
  const rightCandidate = right.candidate;
  const payloadTypeOrder = codeUnitCompare(String(leftCandidate.assetType), String(rightCandidate.assetType));
  if (payloadTypeOrder !== 0) return payloadTypeOrder;
  const loadingTierOrder = codeUnitCompare(String(leftCandidate.loadingTier), String(rightCandidate.loadingTier));
  if (loadingTierOrder !== 0) return loadingTierOrder;
  const sourceLayerOrder = codeUnitCompare(leftCandidate.source.layer, rightCandidate.source.layer);
  if (sourceLayerOrder !== 0) return sourceLayerOrder;

  const leftRule = leftCandidate.rule;
  const rightRule = rightCandidate.rule;
  if (leftRule.mandatory !== rightRule.mandatory) return leftRule.mandatory ? 1 : -1;
  const operationKindOrder = codeUnitCompare(leftRule.operation.kind, rightRule.operation.kind);
  if (operationKindOrder !== 0) return operationKindOrder;
  if (leftRule.operation.kind !== "add" && rightRule.operation.kind !== "add") {
    const targetOrder = codeUnitCompare(String(leftRule.operation.targetAssetId), String(rightRule.operation.targetAssetId));
    if (targetOrder !== 0) return targetOrder;
  }
  if (leftRule.explicitPriority !== undefined && rightRule.explicitPriority === undefined) return 1;
  if (leftRule.explicitPriority === undefined && rightRule.explicitPriority !== undefined) return -1;
  if (leftRule.explicitPriority !== undefined && rightRule.explicitPriority !== undefined && leftRule.explicitPriority !== rightRule.explicitPriority) {
    return leftRule.explicitPriority - rightRule.explicitPriority;
  }
  const mergeModeOrder = codeUnitCompare(leftRule.mergeMode, rightRule.mergeMode);
  if (mergeModeOrder !== 0) return mergeModeOrder;
  if (leftRule.mergeGroup !== undefined && rightRule.mergeGroup === undefined) return 1;
  if (leftRule.mergeGroup === undefined && rightRule.mergeGroup !== undefined) return -1;
  if (leftRule.mergeGroup !== undefined && rightRule.mergeGroup !== undefined) {
    const mergeGroupOrder = codeUnitCompare(leftRule.mergeGroup, rightRule.mergeGroup);
    if (mergeGroupOrder !== 0) return mergeGroupOrder;
  }
  const requiresLengthOrder = leftRule.requires.length - rightRule.requires.length;
  if (requiresLengthOrder !== 0) return requiresLengthOrder;
  for (let index = 0; index < leftRule.requires.length; index += 1) {
    const requirementOrder = codeUnitCompare(leftRule.requires[index] as string, rightRule.requires[index] as string);
    if (requirementOrder !== 0) return requirementOrder;
  }
  for (const axis of RESOLUTION_AXES) {
    const leftSelectors = leftRule.selectors[axis];
    const rightSelectors = rightRule.selectors[axis];
    if (leftSelectors !== undefined && rightSelectors === undefined) return 1;
    if (leftSelectors === undefined && rightSelectors !== undefined) return -1;
    if (leftSelectors === undefined || rightSelectors === undefined) continue;
    const selectorLengthOrder = leftSelectors.length - rightSelectors.length;
    if (selectorLengthOrder !== 0) return selectorLengthOrder;
    for (let index = 0; index < leftSelectors.length; index += 1) {
      const selectorOrder = codeUnitCompare(leftSelectors[index] as string, rightSelectors[index] as string);
      if (selectorOrder !== 0) return selectorOrder;
    }
  }
  return 0;
};

const conflictExplanation = (conflict: ResolutionConflict): string => {
  switch (conflict.kind) {
    case "exclusive_tie": return "Exclusive candidates have the same resolution rank.";
    case "mandatory_conflict": return "Mandatory candidates cannot be resolved together.";
    case "operation_conflict": return "Conflicting operations target the same asset.";
    case "duplicate_identity": return "Candidates with the same asset identity have different meanings.";
    case "dependency_cycle": return "Asset requirements contain a cycle.";
    case "dependency_failure": return "A mandatory asset requirement could not be satisfied.";
  }
};

export const toResolutionReasonDto = (reason: CandidateReason): ResolutionReason => {
  switch (reason.kind) {
    case "included": return { kind: "included", explanation: "The candidate matched the requested scope." };
    case "excluded": {
      if (reason.cause === "scope_mismatch") return { kind: "excluded", explanation: "The candidate did not match the requested scope." };
      if (reason.cause === "invalid_directory") return { kind: "excluded", explanation: "The candidate has an invalid directory selector." };
      return { kind: "excluded", explanation: "The candidate participated in a resolution conflict." };
    }
    case "overridden": return { kind: "overridden", explanation: "The candidate was overridden by a higher-ranked candidate.", overriddenBy: reason.overriddenBy };
    case "disabled": return { kind: "disabled", explanation: "The candidate was disabled by an operation.", disabledBy: reason.disabledBy };
    case "unavailable": return { kind: "unavailable", explanation: "The candidate is unavailable because a requirement failed.", availability: reason.availability };
  }
};

export const toResolutionConflictDto = (conflict: ResolutionConflict): ConflictDto => ({
  explanation: conflictExplanation(conflict),
  involvedAssetIds: [...canonicalIds(conflict.involvedAssetIds)],
});

/**
 * One detail per involved asset, with the id in `path`.
 *
 * The ids do not go into `message`: a consumer would then have to parse prose for this
 * failure while reading `path` for every other one, which is the same split the asset
 * store already refuses to introduce.
 */
export const toResolutionConflictDetails = (
  conflict: ResolutionConflict,
): readonly CoreErrorDetail[] => canonicalIds(conflict.involvedAssetIds).map((assetId) => ({
  path: ["resolution", "conflict", conflict.kind, assetId],
  code: conflict.kind,
  message: conflictExplanation(conflict),
}));

export const resolveScope = (
  input: ResolveScopeInput,
): AssetResult<ResolutionResult> => {
  const contextResult = toResolutionContextSafely(input?.scope);
  if (!contextResult.ok) return contextResult;
  if (!isRecord(input) || !isRecord(input.snapshot) || !Array.isArray(input.snapshot.candidates)) {
    return invalidRequest([detail(["snapshot", "candidates"], "invalid_value", "Snapshot candidates must be a list.")]);
  }

  const conflicts = new Map<string, ResolutionConflict>();
  const addConflict = (conflict: ResolutionConflict): void => {
    const canonical: ResolutionConflict = {
      ...conflict,
      involvedAssetIds: canonicalIds(conflict.involvedAssetIds),
    } as ResolutionConflict;
    conflicts.set(conflictKey(canonical), canonical);
  };

  const invalidStates: CandidateState[] = [];
  const normalizedCandidates: NormalizedCandidate[] = [];
  const validationDetails: CoreErrorDetail[] = [];
  for (const rawCandidate of input.snapshot.candidates) {
    const candidate = rawCandidate as AssetCandidate;
    const structuralDetails = validateCandidate({ candidate });
    if (structuralDetails.length > 0) {
      validationDetails.push(...structuralDetails);
      continue;
    }
    const normalized = normalizeCandidateDirectory(candidate);
    if (normalized.diagnostics !== undefined) {
      invalidStates.push({ candidate, matched: false, reason: invalidDirectoryReason(normalized.diagnostics) });
    } else if (normalized.candidate !== undefined) {
      normalizedCandidates.push(normalized.candidate);
    }
  }

  if (validationDetails.length > 0) return invalidRequest(validationDetails);
  const payloadByIdentity = new Map<string, { assetType: AssetType; loadingTier: LoadingTier }>();
  for (const normalized of normalizedCandidates) {
    const candidate = normalized.candidate;
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
    const mandatory = group.filter((state) => state.candidate.rule.mandatory);
    if (mandatory.length > 1) {
      const conflict: ResolutionConflict = { kind: "mandatory_conflict", involvedAssetIds: canonicalIds(group.map((state) => state.candidate.assetId)) };
      addConflict(conflict);
      for (const state of group) state.reason = resolutionConflictReason(conflict, state.rank);
      continue;
    }
    if (mandatory.length === 1) {
      const winner = mandatory[0]!;
      for (const state of group) {
        if (state !== winner) state.reason = {
          kind: "overridden",
          overriddenBy: winner.candidate.assetId,
          mergeGroup,
          winnerRank: winner.rank!,
        };
      }
      continue;
    }
    const decision = selectExclusiveWinner(group.map((state) => ({
      candidate: state.candidate,
      matchedAxes: state.reason.kind === "included" ? state.reason.matchedAxes : [],
      rank: state.rank!,
    })));
    if (decision.kind === "conflict") {
      addConflict(decision.conflict);
      for (const state of group) state.reason = resolutionConflictReason(decision.conflict, state.rank);
    } else {
      const winner = decision.candidate;
      for (const state of group) {
        if (state.candidate === winner.candidate) continue;
        state.reason = {
          kind: "overridden",
          overriddenBy: winner.candidate.assetId,
          mergeGroup,
          winnerRank: winner.rank,
        };
      }
    }
  }

  const stateById = new Map<string, CandidateState[]>();
  for (const state of states) {
    const group = stateById.get(String(state.candidate.assetId)) ?? [];
    group.push(state);
    stateById.set(String(state.candidate.assetId), group);
  }
  const invalidById = new Set(invalidStates.map((state) => String(state.candidate.assetId)));
  const applyDependencyClosure = (): void => {
    const baseIncluded = states.filter((state) => state.reason.kind === "included");
    const finalTargetsById = new Map<string, CandidateState[]>();
    for (const state of baseIncluded) {
      const group = finalTargetsById.get(String(state.candidate.assetId)) ?? [];
      group.push(state);
      finalTargetsById.set(String(state.candidate.assetId), group);
    }
    type DependencyEdge = { readonly requiredId: AssetId; readonly target: CandidateState };
    type DependencyNode = {
      readonly edges: readonly DependencyEdge[];
      readonly directFailures: readonly { readonly id: AssetId; readonly cause: DependencyCause }[];
    };
    const classifyMissingRequirement = (requiredId: AssetId): DependencyCause => {
      // `finalTargetsById` holds only included candidates, so the reason a requirement
      // failed has to be read off every candidate carrying that id. Classifying from the
      // single included target instead leaves disabled and overridden targets
      // indistinguishable from a malformed one.
      const candidatesForId = stateById.get(String(requiredId)) ?? [];
      const matchedCandidatesForId = candidatesForId.filter((candidate) => candidate.matched);
      if (invalidById.has(String(requiredId))) return "requirement_invalid";
      if (candidatesForId.length === 0) return "missing_requirement";
      if (matchedCandidatesForId.length === 0) return "requirement_out_of_scope";
      if (matchedCandidatesForId.every((candidate) => candidate.reason.kind === "disabled")) return "requirement_disabled";
      if (matchedCandidatesForId.every((candidate) => candidate.reason.kind === "overridden")) return "requirement_overridden";
      return "requirement_invalid";
    };
    const dependencyNodes = new Map<CandidateState, DependencyNode>();
    const dependencyTargets = new Map<CandidateState, CandidateState[]>();
    const dependents = new Map<CandidateState, CandidateState[]>();
    for (const state of baseIncluded) {
      const edges: DependencyEdge[] = [];
      const directFailures: { id: AssetId; cause: DependencyCause }[] = [];
      for (const requiredId of state.candidate.rule.requires) {
        const targets = finalTargetsById.get(String(requiredId)) ?? [];
        // More than one included candidate for the same id is an unresolved identity, not a
        // dependency the closure may pick from: falling through to the classification below
        // reports it rather than letting an arbitrary one satisfy the requirement.
        const target = targets.length === 1 ? targets[0] : undefined;
        if (target === undefined) directFailures.push({ id: requiredId, cause: classifyMissingRequirement(requiredId) });
        else edges.push({ requiredId, target });
      }
      dependencyNodes.set(state, { edges, directFailures });
      dependencyTargets.set(state, edges.map((edge) => edge.target));
      for (const edge of edges) {
        const stateDependents = dependents.get(edge.target) ?? [];
        stateDependents.push(state);
        dependents.set(edge.target, stateDependents);
      }
    }

    const orderedBaseIncluded = baseIncluded.slice().sort(compareCandidatesForOutput);
    const visited = new Set<CandidateState>();
    const finishOrder: CandidateState[] = [];
    for (const start of orderedBaseIncluded) {
      if (visited.has(start)) continue;
      const stack: { state: CandidateState; expanded: boolean }[] = [{ state: start, expanded: false }];
      while (stack.length > 0) {
        const frame = stack.pop()!;
        if (frame.expanded) {
          finishOrder.push(frame.state);
          continue;
        }
        if (visited.has(frame.state)) continue;
        visited.add(frame.state);
        stack.push({ state: frame.state, expanded: true });
        const targets = (dependencyTargets.get(frame.state) ?? []).slice().sort(compareCandidatesForOutput);
        for (let index = targets.length - 1; index >= 0; index -= 1) {
          const target = targets[index]!;
          if (!visited.has(target)) stack.push({ state: target, expanded: false });
        }
      }
    }

    const components: CandidateState[][] = [];
    const componentByState = new Map<CandidateState, number>();
    for (const start of finishOrder.slice().reverse()) {
      if (componentByState.has(start)) continue;
      const componentIndex = components.length;
      const component: CandidateState[] = [];
      const stack = [start];
      componentByState.set(start, componentIndex);
      while (stack.length > 0) {
        const state = stack.pop()!;
        component.push(state);
        for (const dependent of dependents.get(state) ?? []) {
          if (componentByState.has(dependent)) continue;
          componentByState.set(dependent, componentIndex);
          stack.push(dependent);
        }
      }
      component.sort(compareCandidatesForOutput);
      components.push(component);
    }

    const componentDependencies = components.map(() => new Set<number>());
    const componentDependents = components.map(() => new Set<number>());
    for (const [state, targets] of dependencyTargets) {
      const stateComponent = componentByState.get(state)!;
      for (const target of targets) {
        const targetComponent = componentByState.get(target)!;
        if (stateComponent === targetComponent) continue;
        componentDependencies[stateComponent]!.add(targetComponent);
        componentDependents[targetComponent]!.add(stateComponent);
      }
    }
    const cyclicComponents = new Set<number>();
    for (let index = 0; index < components.length; index += 1) {
      const component = components[index]!;
      if (component.length > 1 || (dependencyTargets.get(component[0]!) ?? []).some((target) => target === component[0])) {
        cyclicComponents.add(index);
      }
    }

    const readyComponents = components
      .map((_, index) => index)
      .filter((index) => componentDependencies[index]!.size === 0);
    const processedComponents: number[] = [];
    for (let cursor = 0; cursor < readyComponents.length; cursor += 1) {
      const componentIndex = readyComponents[cursor]!;
      processedComponents.push(componentIndex);
      for (const dependent of componentDependents[componentIndex]!) {
        const dependencies = componentDependencies[dependent]!;
        dependencies.delete(componentIndex);
        if (dependencies.size === 0) readyComponents.push(dependent);
      }
    }

    const outcomes = new Map<CandidateState, DependencyOutcome>();
    for (const componentIndex of processedComponents) {
      const component = components[componentIndex]!;
      const componentIds = cyclicComponents.has(componentIndex)
        ? canonicalIds(component.map((state) => state.candidate.assetId))
        : undefined;
      const componentStates = new Set(component);
      for (const state of component) {
        const node = dependencyNodes.get(state)!;
        const failures = [...node.directFailures];
        let cycleIds = componentIds;
        if (componentIds !== undefined) {
          for (const edge of node.edges) {
            if (componentStates.has(edge.target)) failures.push({ id: edge.requiredId, cause: "requirement_cycle" });
          }
        }
        for (const edge of node.edges) {
          if (componentStates.has(edge.target)) continue;
          const outcome = outcomes.get(edge.target);
          if (outcome === undefined) throw new Error("Dependency component order is incomplete.");
          if (!outcome.ok) {
            failures.push({ id: edge.requiredId, cause: outcome.cause });
            if (outcome.cycleIds !== undefined) {
              cycleIds = cycleIds === undefined
                ? outcome.cycleIds
                : canonicalIds([...cycleIds, ...outcome.cycleIds]);
            }
          }
        }
        failures.sort((left, right) => codeUnitCompare(left.id, right.id));
        const outcome: DependencyOutcome = failures.length === 0
          ? { ok: true }
          : {
              ok: false,
              cause: failures[0]!.cause,
              failedRequirements: failures.map((failure) => failure.id),
              ...(cycleIds === undefined ? {} : { cycleIds }),
            };
        outcomes.set(state, outcome);
      }
    }

    for (const state of baseIncluded) {
      const outcome = outcomes.get(state)!;
      if (outcome.ok) continue;
      state.reason = {
        kind: "unavailable",
        availability: "unavailable",
        cause: outcome.cause,
        failedRequirements: [...outcome.failedRequirements],
      };
      if (state.candidate.rule.mandatory) {
        if (outcome.cycleIds !== undefined) {
          addConflict({
            kind: "dependency_cycle",
            involvedAssetIds: canonicalIds([state.candidate.assetId, ...(outcome.cycleIds ?? outcome.failedRequirements)]),
          });
        }
        if (outcome.cause !== "requirement_cycle") {
          addConflict({
            kind: "dependency_failure",
            failedRequirement: outcome.failedRequirements[0]!,
            involvedAssetIds: canonicalIds([state.candidate.assetId, ...outcome.failedRequirements]),
          });
        }
      }
    }
  };

  const operationBaseReasons = new Map(states.map((state) => [state, state.reason] as const));
  const operationBaseConflicts = new Map(conflicts);
  type OperationAction = { issuer: CandidateState; target: CandidateState; kind: "override" | "disable" };
  const blockedOperationIssuers = new Set<CandidateState>();
  const blockedOperationReasons = new Map<CandidateState, CandidateReason>();
  const revivedOperationIssuers = new Set<CandidateState>();
  const resolveOperations = (): {
    readonly appliedActions: readonly OperationAction[];
    readonly eligibleIssuers: ReadonlySet<CandidateState>;
  } => {
    for (const state of states) state.reason = operationBaseReasons.get(state)!;
    conflicts.clear();
    for (const [key, conflict] of operationBaseConflicts) conflicts.set(key, conflict);
    applyDependencyClosure();
    const eligibleIssuers = new Set(states.filter((state) =>
      state.candidate.rule.operation.kind !== "add" &&
      !blockedOperationIssuers.has(state) &&
      (state.reason.kind === "included" || revivedOperationIssuers.has(state))));
    for (const state of states) state.reason = operationBaseReasons.get(state)!;
    conflicts.clear();
    for (const [key, conflict] of operationBaseConflicts) conflicts.set(key, conflict);

    const appliedActions: OperationAction[] = [];
    const operationGroups = new Map<CandidateState, OperationAction[]>();
    const operationFailureReasons = new Map<CandidateState, CandidateReason>();
    for (const issuer of eligibleIssuers) {
      const operation = issuer.candidate.rule.operation;
      if (operation.kind === "add") continue;
      const targetCandidates = states.filter((state) => {
        const targetReason = operationBaseReasons.get(state)!;
        return state !== issuer && state.matched &&
          state.candidate.assetId === operation.targetAssetId &&
          (targetReason.kind === "included" ||
            (targetReason.kind === "overridden" &&
              (operation.targetAssetId === issuer.candidate.assetId
                ? isSameIdOverlayPair(issuer, state)
                : targetReason.overriddenBy === issuer.candidate.assetId))) &&
          (operation.targetAssetId !== issuer.candidate.assetId || isSameIdOverlayPair(issuer, state));
      });
      const targetIsAmbiguous = operation.targetAssetId !== issuer.candidate.assetId && targetCandidates.length !== 1;
      if (targetCandidates.length === 0 || targetIsAmbiguous) {
        const conflict: ResolutionConflict = {
          kind: "operation_conflict",
          targetAssetId: operation.targetAssetId,
          involvedAssetIds: canonicalIds([issuer.candidate.assetId, operation.targetAssetId]),
        };
        addConflict(conflict);
        operationFailureReasons.set(issuer, resolutionConflictReason(conflict, issuer.rank));
        continue;
      }
      if (targetCandidates.some((target) => target.candidate.rule.mandatory)) {
        const conflict: ResolutionConflict = {
          kind: "mandatory_conflict",
          involvedAssetIds: canonicalIds([issuer.candidate.assetId, ...targetCandidates.map((target) => target.candidate.assetId)]),
        };
        addConflict(conflict);
        operationFailureReasons.set(issuer, resolutionConflictReason(conflict, issuer.rank));
        continue;
      }
      if (operation.kind === "override" && (
        issuer.candidate.rule.mergeGroup === undefined ||
        targetCandidates.some((target) => target.candidate.rule.mergeGroup === undefined ||
          issuer.candidate.rule.mergeGroup !== target.candidate.rule.mergeGroup)
      )) {
        const conflict: ResolutionConflict = {
          kind: "operation_conflict",
          targetAssetId: operation.targetAssetId,
          involvedAssetIds: canonicalIds([issuer.candidate.assetId, operation.targetAssetId]),
        };
        addConflict(conflict);
        operationFailureReasons.set(issuer, resolutionConflictReason(conflict, issuer.rank));
        continue;
      }
      for (const target of targetCandidates) {
        const actions = operationGroups.get(target) ?? [];
        actions.push({ issuer, target, kind: operation.kind });
        operationGroups.set(target, actions);
      }
    }

    for (const [issuer, failureReason] of operationFailureReasons) issuer.reason = failureReason;

    for (const actions of operationGroups.values()) {
      if (actions.length === 0) continue;
      const target = actions[0]!.target;
      const bestRank = actions.reduce((best, action) => compareResolutionRank(action.issuer.rank!, best) > 0 ? action.issuer.rank! : best, actions[0]!.issuer.rank!);
      const best = actions.filter((action) => sameResolutionRank(action.issuer.rank!, bestRank));
      const allDisable = best.every((action) => action.kind === "disable");
      if (best.length > 1 && !allDisable) {
        const conflict: ResolutionConflict = {
          kind: "operation_conflict",
          targetAssetId: target.candidate.assetId,
          involvedAssetIds: canonicalIds([target.candidate.assetId, ...actions.map((action) => action.issuer.candidate.assetId)]),
        };
        addConflict(conflict);
        for (const action of actions) action.issuer.reason = resolutionConflictReason(conflict, action.issuer.rank);
        continue;
      }
      const winner = allDisable
        ? best.slice().sort((left, right) => codeUnitCompare(String(left.issuer.candidate.assetId), String(right.issuer.candidate.assetId)))[0]!
        : best[0]!;
      for (const action of actions) {
        if (action === winner || action.kind === winner.kind) continue;
        const conflict: ResolutionConflict = {
          kind: "operation_conflict",
          targetAssetId: target.candidate.assetId,
          involvedAssetIds: canonicalIds([target.candidate.assetId, action.issuer.candidate.assetId, winner.issuer.candidate.assetId]),
        };
        addConflict(conflict);
        action.issuer.reason = resolutionConflictReason(conflict, action.issuer.rank);
      }
      appliedActions.push(winner);
      if (winner.kind === "disable") target.reason = { kind: "disabled", disabledBy: winner.issuer.candidate.assetId };
      else target.reason = {
        kind: "overridden",
        overriddenBy: winner.issuer.candidate.assetId,
        mergeGroup: winner.issuer.candidate.rule.mergeGroup as string,
        winnerRank: winner.issuer.rank!,
      };
    }
    return { appliedActions, eligibleIssuers };
  };

  const findOperationCycle = (
    actions: readonly OperationAction[],
  ): readonly OperationAction[] | undefined => {
    const outgoing = new Map<CandidateState, OperationAction[]>();
    for (const action of actions) {
      const issuerActions = outgoing.get(action.issuer) ?? [];
      issuerActions.push(action);
      outgoing.set(action.issuer, issuerActions);
    }
    const completed = new Set<CandidateState>();
    const visit = (
      state: CandidateState,
      pathStates: readonly CandidateState[],
      pathActions: readonly OperationAction[],
    ): readonly OperationAction[] | undefined => {
      const cycleStart = pathStates.indexOf(state);
      if (cycleStart >= 0) return pathActions.slice(cycleStart);
      if (completed.has(state)) return undefined;
      const nextStates = [...pathStates, state];
      for (const action of outgoing.get(state) ?? []) {
        const cycle = visit(action.target, nextStates, [...pathActions, action]);
        if (cycle !== undefined) return cycle;
      }
      completed.add(state);
      return undefined;
    };
    for (const action of actions) {
      const cycle = visit(action.issuer, [], []);
      if (cycle !== undefined) return cycle;
    }
    return undefined;
  };

  const findOperationCycles = (
    actions: readonly OperationAction[],
  ): readonly OperationAction[][] => {
    const outgoing = new Map<CandidateState, OperationAction[]>();
    const graphStates = new Set<CandidateState>();
    const compareActions = (left: OperationAction, right: OperationAction): number => {
      const issuerOrder = compareCandidatesForOutput(left.issuer, right.issuer);
      if (issuerOrder !== 0) return issuerOrder;
      const targetOrder = compareCandidatesForOutput(left.target, right.target);
      if (targetOrder !== 0) return targetOrder;
      return codeUnitCompare(left.kind, right.kind);
    };
    for (const action of actions) {
      const issuerActions = outgoing.get(action.issuer) ?? [];
      issuerActions.push(action);
      outgoing.set(action.issuer, issuerActions);
      graphStates.add(action.issuer);
      graphStates.add(action.target);
    }

    let nextIndex = 0;
    const indices = new Map<CandidateState, number>();
    const lowLinks = new Map<CandidateState, number>();
    const stack: CandidateState[] = [];
    const onStack = new Set<CandidateState>();
    const components: CandidateState[][] = [];
    const strongConnect = (state: CandidateState): void => {
      indices.set(state, nextIndex);
      lowLinks.set(state, nextIndex);
      nextIndex += 1;
      stack.push(state);
      onStack.add(state);
      for (const action of (outgoing.get(state) ?? []).slice().sort(compareActions)) {
        const targetIndex = indices.get(action.target);
        if (targetIndex === undefined) {
          strongConnect(action.target);
          lowLinks.set(state, Math.min(lowLinks.get(state)!, lowLinks.get(action.target)!));
        } else if (onStack.has(action.target)) {
          lowLinks.set(state, Math.min(lowLinks.get(state)!, targetIndex));
        }
      }
      if (lowLinks.get(state) !== indices.get(state)) return;
      const component: CandidateState[] = [];
      let member: CandidateState | undefined;
      do {
        member = stack.pop();
        if (member === undefined) throw new Error("Operation cycle stack underflow.");
        onStack.delete(member);
        component.push(member);
      } while (member !== state);
      components.push(component);
    };

    for (const state of [...graphStates].sort(compareCandidatesForOutput)) {
      if (!indices.has(state)) strongConnect(state);
    }

    const cycles: OperationAction[][] = [];
    for (const component of components) {
      const members = new Set(component);
      const componentActions = actions
        .filter((action) => members.has(action.issuer) && members.has(action.target))
        .slice()
        .sort(compareActions);
      const hasCycle = component.length > 1 || componentActions.some((action) => action.issuer === action.target);
      if (!hasCycle) continue;
      const cycle = findOperationCycle(componentActions);
      if (cycle !== undefined) cycles.push([...cycle]);
    }
    return cycles.sort((left, right) => codeUnitCompare(
      canonicalIds(left.flatMap((action) => [action.issuer.candidate.assetId, action.target.candidate.assetId])).join("\u0000"),
      canonicalIds(right.flatMap((action) => [action.issuer.candidate.assetId, action.target.candidate.assetId])).join("\u0000"),
    ));
  };

  const findBlockedOperationIssuers = (
    actions: readonly OperationAction[],
  ): readonly CandidateState[] => {
    const actionsByIssuerId = new Map<string, CandidateState[]>();
    for (const action of actions) {
      const issuers = actionsByIssuerId.get(String(action.issuer.candidate.assetId)) ?? [];
      if (!issuers.includes(action.issuer)) issuers.push(action.issuer);
      actionsByIssuerId.set(String(action.issuer.candidate.assetId), issuers);
    }
    const blockedThisPass = new Set<CandidateState>(
      actions.filter((action) => action.issuer.reason.kind !== "included").map((action) => action.issuer),
    );
    let changed = true;
    while (changed) {
      changed = false;
      for (const action of actions) {
        const issuer = action.issuer;
        if (!blockedThisPass.has(issuer)) continue;
        const blockerId = issuer.reason.kind === "disabled"
          ? issuer.reason.disabledBy
          : issuer.reason.kind === "overridden"
            ? issuer.reason.overriddenBy
            : undefined;
        if (blockerId === undefined) continue;
        const blockerIssuers = actionsByIssuerId.get(String(blockerId)) ?? [];
        if (blockerIssuers.length > 0 && blockerIssuers.every((blocker) => blockedThisPass.has(blocker))) {
          blockedThisPass.delete(issuer);
          changed = true;
        }
      }
    }
    return [...blockedThisPass];
  };

  for (;;) {
    const { appliedActions, eligibleIssuers } = resolveOperations();
    applyDependencyClosure();
    const operationCycles = findOperationCycles(appliedActions);
    if (operationCycles.length > 0) {
      const cycleConflicts = operationCycles.map((operationCycle) => {
        const cycleAssetIds = canonicalIds(operationCycle.flatMap((action) => [
          action.issuer.candidate.assetId,
          action.target.candidate.assetId,
        ]));
        return {
          cycle: operationCycle,
          conflict: {
            kind: "operation_conflict",
            targetAssetId: cycleAssetIds[0]!,
            involvedAssetIds: cycleAssetIds,
          } as ResolutionConflict,
        };
      });
      for (const { cycle } of cycleConflicts) {
        for (const action of cycle) blockedOperationIssuers.add(action.issuer);
      }
      resolveOperations();
      applyDependencyClosure();
      for (const { cycle, conflict } of cycleConflicts) {
        addConflict(conflict);
        for (const action of cycle) action.issuer.reason = resolutionConflictReason(conflict, action.issuer.rank);
      }
      break;
    }
    const newlyBlocked = findBlockedOperationIssuers(appliedActions)
      .filter((issuer) => !blockedOperationIssuers.has(issuer));
    const newlyRevivedIssuers = states.filter((state) =>
      state.reason.kind === "included" &&
      state.candidate.rule.operation.kind !== "add" &&
      !eligibleIssuers.has(state) &&
      !blockedOperationIssuers.has(state) &&
      !revivedOperationIssuers.has(state));
    const hasRevivedEligibleIssuer = newlyRevivedIssuers.length > 0;
    for (const issuer of newlyRevivedIssuers) revivedOperationIssuers.add(issuer);
    for (const issuer of newlyBlocked) {
      blockedOperationIssuers.add(issuer);
      blockedOperationReasons.set(issuer, issuer.reason);
    }
    if (newlyBlocked.length === 0 && !hasRevivedEligibleIssuer) break;
  }

  for (const issuer of blockedOperationIssuers) {
    const priorReason = blockedOperationReasons.get(issuer);
    const operation = issuer.candidate.rule.operation;
    if (priorReason?.kind !== "unavailable" ||
      operation.kind === "add" ||
      priorReason.failedRequirements.includes(operation.targetAssetId) ||
      issuer.reason.kind !== "included") continue;
    const conflict: ResolutionConflict = {
      kind: "operation_conflict",
      targetAssetId: operation.targetAssetId,
      involvedAssetIds: canonicalIds([issuer.candidate.assetId, operation.targetAssetId]),
    };
    addConflict(conflict);
    issuer.reason = resolutionConflictReason(conflict, issuer.rank);
  }

  const allStates = [...states, ...invalidStates].sort(compareCandidatesForOutput);
  const evaluationStates = allStates;
  const resultConflicts = [...conflicts.values()].sort((left, right) => {
    const kindOrder = codeUnitCompare(left.kind, right.kind);
    if (kindOrder !== 0) return kindOrder;
    return codeUnitCompare(conflictKey(left), conflictKey(right));
  });
  return {
    ok: true,
    value: {
      scope: contextResult.value,
      evaluations: evaluationStates.map((state) => ({ candidate: state.candidate, reason: state.reason })),
      outcome: resultConflicts.length === 0 ? "resolved" : "conflicted",
      conflicts: resultConflicts,
    },
  };
};

const toResolutionContextSafely = (
  scope: unknown,
): AssetResult<ResolutionContext> => {
  if (!isRecord(scope)) return invalidRequest([detail(["scope"], "invalid_value", "The resolution scope must be an object.")]);
  const input = scope as ResolutionScopeInput;
  return toResolutionContext(input);
};
