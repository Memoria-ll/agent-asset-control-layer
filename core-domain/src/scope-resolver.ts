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
import type { AssetOperationKind, AssetTypeContract, AssetTypeContractRegistry } from "./asset-type-contracts.ts";
import { DEFAULT_ASSET_TYPE_CONTRACTS } from "./asset-type-contracts.ts";
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

type RankedCandidate = NormalizedCandidate & {
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
  | { readonly kind: "winner"; readonly candidate: RankedCandidate }
  | { readonly kind: "conflict"; readonly conflict: ResolutionConflict };

export type ResolutionRank = {
  readonly explicitPriority: number;
  readonly matchingAxisCount: number;
  readonly scopePrecedence: readonly number[];
  readonly directoryDepth: number;
  readonly sourceLayerPrecedence: 0 | 1 | 2;
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
    }
  | {
      readonly kind: "asset_type_conflict";
      readonly involvedAssetIds: readonly AssetId[];
    };

export type ResolveScopeInput = {
  readonly scope: ResolutionScopeInput;
  readonly snapshot: ResolutionSnapshot;
  readonly contracts?: AssetTypeContractRegistry;
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
      readonly nonCycleFailedRequirements: readonly AssetId[];
    };

/**
 * The more specific layer wins, so a personal asset overrides a global one.
 *
 * Ranking a global asset above a personal one is not the way a global asset is
 * protected: `mandatory` is. Layer order decides which of two interchangeable
 * candidates is preferred; a global asset that must survive a personal override
 * declares itself mandatory, and the hard rule then holds regardless of rank.
 */
const sourceLayerPrecedence = (layer: ResolutionSourceLayer): 0 | 1 | 2 => {
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
    const layerOrder = sourceLayerPrecedence(current.candidate.source.layer) - sourceLayerPrecedence(best.candidate.source.layer);
    if (layerOrder < 0) return best;
    if (layerOrder > 0) return current;
    return codeUnitCompare(current.candidate.source.sourceId, best.candidate.source.sourceId) < 0 ? current : best;
  }, first);
};

const deduplicateExactCandidates = (
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

const isSameIdOverlayPair = (
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

const hasUnresolvedIdentityPair = (
  group: readonly CandidateState[],
): boolean => group.some((left, leftIndex) =>
  group.slice(leftIndex + 1).some((right) =>
    !isSameIdOverlayPair(left, right) && !isSameIdOverlayPair(right, left)));

/**
 * The default scope precedence, keyed by the resolver axis vocabulary rather than the
 * on-disk one.
 *
 * `stageId` is 45 because the requirement's precedence table has no Stage row: the same
 * section lists its resolution inputs as Project / Workflow Stage / Task Type, which puts
 * Stage between Workflow and Task Type. The gap at 20 belongs to a team axis that the
 * scope input does not carry, so no request can reach it.
 */
const SCOPE_PRECEDENCE: Readonly<Record<ResolutionAxis, number>> = {
  projectId: 30,
  workflowId: 40,
  stageId: 45,
  taskTypeId: 50,
  roleId: 60,
  providerId: 70,
  runtimeId: 80,
  modelId: 90,
  directory: 100,
};

const compareScopePrecedence = (left: readonly number[], right: readonly number[]): number => {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftRank = left[index] ?? -1;
    const rightRank = right[index] ?? -1;
    if (leftRank !== rightRank) return leftRank - rightRank;
  }
  return 0;
};

const compareRank = (left: ResolutionRank, right: ResolutionRank): number => {
  if (left.explicitPriority !== right.explicitPriority) return left.explicitPriority - right.explicitPriority;
  if (left.matchingAxisCount !== right.matchingAxisCount) return left.matchingAxisCount - right.matchingAxisCount;
  const vector = compareScopePrecedence(left.scopePrecedence, right.scopePrecedence);
  if (vector !== 0) return vector;
  if (left.directoryDepth !== right.directoryDepth) return left.directoryDepth - right.directoryDepth;
  return left.sourceLayerPrecedence - right.sourceLayerPrecedence;
};

const compareDirectoryRank = (left: ResolutionRank, right: ResolutionRank): number => {
  if (left.explicitPriority !== right.explicitPriority) return left.explicitPriority - right.explicitPriority;
  if (left.directoryDepth !== right.directoryDepth) return left.directoryDepth - right.directoryDepth;
  return left.matchingAxisCount - right.matchingAxisCount;
};

const matchesDirectoryAxis = (rank: ResolutionRank): boolean =>
  // Do not use directoryDepth > 0: a root directory match has depth 0.
  rank.scopePrecedence.includes(SCOPE_PRECEDENCE.directory);

const beatsCandidate = (left: ResolutionRank, right: ResolutionRank): boolean =>
  matchesDirectoryAxis(left) && matchesDirectoryAxis(right)
    ? compareDirectoryRank(left, right) > 0
    : compareRank(left, right) > 0;

const selectUnbeaten = <Item extends { readonly rank: ResolutionRank }>(
  items: readonly Item[],
): readonly Item[] =>
  // Do not reduce through partial winners: directory precedence is non-transitive across mixed pairs.
  items.filter((item) => !items.some((other) => other !== item && beatsCandidate(other.rank, item.rank)));

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
    }
  }

  if (mismatchedAxes.length > 0) return { matched: false, mismatchedAxes };
  return {
    matched: true,
    matchedAxes,
    rank: {
      explicitPriority: candidate.candidate.rule.explicitPriority ?? -1,
      matchingAxisCount: matchedAxes.length,
      scopePrecedence: matchedAxes.map((axis) => SCOPE_PRECEDENCE[axis]).sort((left, right) => right - left),
      directoryDepth,
      sourceLayerPrecedence: sourceLayerPrecedence(candidate.candidate.source.layer),
    },
  };
};

const selectExclusiveWinner = (candidates: readonly RankedCandidate[]): ExclusiveDecision => {
  const first = candidates[0];
  if (first === undefined) throw new Error("Cannot select an exclusive winner from an empty group.");
  const unbeaten = selectUnbeaten(candidates);
  if (unbeaten.length === 1) return { kind: "winner", candidate: unbeaten[0] as RankedCandidate };
  return {
    kind: "conflict",
    conflict: {
      kind: "exclusive_tie",
      mergeGroup: first.candidate.rule.mergeGroup as string,
      involvedAssetIds: canonicalIds((unbeaten.length === 0 ? candidates : unbeaten).map((candidate) => candidate.candidate.assetId)),
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

const validateCandidate = (
  candidate: NormalizedCandidate,
  contracts: AssetTypeContractRegistry,
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
    const rankOrder = compareRank(right.rank, left.rank);
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
    // Covers a cycle as well as an equal rank: neither leaves a candidate that beats all others.
    case "exclusive_tie": return "Exclusive candidates have no single highest-ranked candidate.";
    case "mandatory_conflict": return "Mandatory candidates cannot be resolved together.";
    case "operation_conflict": return "Conflicting operations target the same asset.";
    case "duplicate_identity": return "Candidates with the same asset identity have different meanings.";
    case "dependency_cycle": return "Asset requirements contain a cycle.";
    case "dependency_failure": return "A mandatory asset requirement could not be satisfied.";
    case "asset_type_conflict": return "Candidates of different asset types cannot be combined.";
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

  const conflicts = new Map<string, ResolutionConflict>();
  const addConflict = (conflict: ResolutionConflict): void => {
    const canonical: ResolutionConflict = {
      ...conflict,
      involvedAssetIds: canonicalIds(conflict.involvedAssetIds),
    } as ResolutionConflict;
    conflicts.set(conflictKey(canonical), canonical);
  };

  type CandidateRecord = {
    readonly candidate: AssetCandidate;
    readonly normalized?: NormalizedCandidate;
    readonly directoryDiagnostics?: readonly CoreErrorDetail[];
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
    const structuralDetails = validateCandidate({ candidate }, contracts);
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
    const decision = selectExclusiveWinner(group.map((state) => ({
      candidate: state.candidate,
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
  const baseReasons = new Map(states.map((state) => [state, state.reason] as const));
  const baseIncluded = new Set(states.filter((state) => state.reason.kind === "included"));
  const operationIssuers = [...baseIncluded]
    .filter((state) => state.candidate.rule.operation.kind !== "add")
    .sort(compareCandidatesForOutput);
  const operationIssuerSet = new Set(operationIssuers);

  type FixedStatus =
    | { readonly kind: "included" }
    | { readonly kind: "disabled"; readonly disabledBy: AssetId }
    | { readonly kind: "overridden"; readonly overriddenBy: AssetId; readonly mergeGroup: string; readonly winnerRank: ResolutionRank }
    | { readonly kind: "conflict"; readonly conflict: ResolutionConflict };
  type OperationAction = { readonly issuer: CandidateState; readonly target: CandidateState; readonly kind: "override" | "disable" };
  type OperationFailure = { readonly issuer: CandidateState; readonly conflict: ResolutionConflict };
  type OperationConflictEntry = { readonly conflict: ResolutionConflict; readonly issuers: readonly CandidateState[] };
  type OperationCycle = { readonly conflict: ResolutionConflict; readonly issuers: readonly CandidateState[] };

  /** Kosaraju with explicit stacks; valid snapshots have no depth limit. */
  const stronglyConnectedComponents = <Node>(
    nodes: readonly Node[],
    outgoing: ReadonlyMap<Node, readonly Node[]>,
    compare: (left: Node, right: Node) => number,
  ): Node[][] => {
    const ordered = nodes.slice().sort(compare);
    const reverse = new Map<Node, Node[]>();
    for (const node of ordered) reverse.set(node, []);
    for (const node of ordered) {
      for (const target of outgoing.get(node) ?? []) {
        const incoming = reverse.get(target) ?? [];
        incoming.push(node);
        reverse.set(target, incoming);
      }
    }

    const visited = new Set<Node>();
    const finish: Node[] = [];
    for (const start of ordered) {
      if (visited.has(start)) continue;
      const stack: { readonly node: Node; nextIndex: number }[] = [{ node: start, nextIndex: 0 }];
      visited.add(start);
      while (stack.length > 0) {
        const frame = stack[stack.length - 1]!;
        const neighbors = (outgoing.get(frame.node) ?? []).slice().sort(compare);
        if (frame.nextIndex < neighbors.length) {
          const target = neighbors[frame.nextIndex]!;
          frame.nextIndex += 1;
          if (visited.has(target)) continue;
          visited.add(target);
          stack.push({ node: target, nextIndex: 0 });
        } else {
          stack.pop();
          finish.push(frame.node);
        }
      }
    }

    const assigned = new Set<Node>();
    const components: Node[][] = [];
    for (const start of finish.slice().reverse()) {
      if (assigned.has(start)) continue;
      const component: Node[] = [];
      const stack: Node[] = [start];
      assigned.add(start);
      while (stack.length > 0) {
        const node = stack.pop()!;
        component.push(node);
        const neighbors = (reverse.get(node) ?? []).slice().sort(compare);
        for (const target of neighbors) {
          if (assigned.has(target)) continue;
          assigned.add(target);
          stack.push(target);
        }
      }
      component.sort(compare);
      components.push(component);
    }
    return components;
  };

  const statusForState = (
    state: CandidateState,
    statuses: ReadonlyMap<CandidateState, FixedStatus>,
  ): FixedStatus | undefined => {
    if (baseIncluded.has(state)) return statuses.get(state);
    const reason = baseReasons.get(state);
    if (reason?.kind === "disabled") return { kind: "disabled", disabledBy: reason.disabledBy };
    if (reason?.kind === "overridden") {
      return {
        kind: "overridden",
        overriddenBy: reason.overriddenBy,
        mergeGroup: reason.mergeGroup,
        winnerRank: reason.winnerRank,
      };
    }
    if (reason?.kind === "excluded" && reason.cause === "resolution_conflict") {
      return { kind: "conflict", conflict: reason.conflict };
    }
    return undefined;
  };

  type DependencyNode = {
    readonly edges: readonly { readonly requiredId: AssetId; readonly target: CandidateState }[];
    readonly directFailures: readonly { readonly id: AssetId; readonly cause: DependencyCause }[];
  };

  const dependencyOutcomes = (
    statuses: ReadonlyMap<CandidateState, FixedStatus>,
  ): ReadonlyMap<CandidateState, DependencyOutcome> => {
    const activeById = new Map<string, CandidateState[]>();
    for (const state of baseIncluded) {
      if (statuses.get(state)?.kind !== "included") continue;
      const group = activeById.get(String(state.candidate.assetId)) ?? [];
      group.push(state);
      activeById.set(String(state.candidate.assetId), group);
    }

    const reasonKind = (state: CandidateState): string | undefined => {
      const status = statusForState(state, statuses);
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
      dependencyNodes.set(state, { edges, directFailures });
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
        return node.directFailures.some((failure) => failure.cause !== "requirement_cycle") ||
          node.edges.some((edge) => {
            if (componentStates.has(edge.target)) return false;
            const outcome = outcomes.get(edge.target);
            return outcome !== undefined && !outcome.ok && outcome.nonCycleFailedRequirements.length > 0;
          });
      });
      for (const state of component) {
        const node = dependencyNodes.get(state)!;
        const failures = [...node.directFailures];
        const nonCycleFailedRequirements = node.directFailures
          .filter((failure) => failure.cause !== "requirement_cycle")
          .map((failure) => failure.id);
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
          if (outcome === undefined || outcome.ok) continue;
          failures.push({ id: edge.requiredId, cause: outcome.cause });
          if (outcome.cycleIds !== undefined) {
            cycleIds = cycleIds === undefined ? outcome.cycleIds : canonicalIds([...cycleIds, ...outcome.cycleIds]);
          }
          if (outcome.nonCycleFailedRequirements.length > 0) nonCycleFailedRequirements.push(edge.requiredId);
        }
        failures.sort((left, right) => codeUnitCompare(left.id, right.id));
        nonCycleFailedRequirements.sort(codeUnitCompare);
        if (failures.length === 0) {
          outcomes.set(state, { ok: true });
        } else {
          outcomes.set(state, {
            ok: false,
            cause: failures[0]!.cause,
            failedRequirements: failures.map((failure) => failure.id),
            ...(cycleIds === undefined ? {} : { cycleIds }),
            nonCycleFailedRequirements: canonicalIds(nonCycleFailedRequirements),
          });
        }
      }
    }
    return outcomes;
  };

  const makeOperationConflict = (targetAssetId: AssetId, involvedAssetIds: readonly AssetId[]): ResolutionConflict => ({
    kind: "operation_conflict",
    targetAssetId,
    involvedAssetIds: canonicalIds(involvedAssetIds),
  });

  type OperationPass = {
    readonly statuses: ReadonlyMap<CandidateState, FixedStatus>;
    readonly dependency: ReadonlyMap<CandidateState, DependencyOutcome>;
    readonly selectedActions: readonly OperationAction[];
    readonly operationConflicts: readonly OperationConflictEntry[];
    readonly failures: readonly OperationFailure[];
    readonly cycles: readonly OperationCycle[];
    readonly nextPlan: ReadonlySet<CandidateState>;
  };

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

    const dependency = dependencyOutcomes(statuses);
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

  const finalReasons = new Map<CandidateState, CandidateReason>();
  for (const state of states) {
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
      if (outcome.ok) finalReasons.set(state, baseReasons.get(state)!);
      else finalReasons.set(state, {
        kind: "unavailable",
        availability: "unavailable",
        cause: outcome.cause,
        failedRequirements: [...outcome.failedRequirements],
      });
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

  for (const state of states) {
    const reason = finalReasons.get(state)!;
    if (reason.kind !== "unavailable" || !state.candidate.rule.mandatory) continue;
    const outcome = finalPass.dependency.get(state)!;
    if (outcome.ok) continue;
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

const toResolutionContextSafely = (
  scope: unknown,
): AssetResult<ResolutionContext> => {
  if (!isRecord(scope)) return invalidRequest([detail(["scope"], "invalid_value", "The resolution scope must be an object.")]);
  const input = scope as ResolutionScopeInput;
  return toResolutionContext(input);
};
