import { EXECUTION_MODES } from "@aacl/shared";
import type { AssetId, AssetRevision, ExecutionMode, LoadingTier, SkillId } from "@aacl/shared";
import type { CapabilityDependency, CapabilityReference } from "./capabilities/dependencies.ts";
import {
  asAssetId,
  parseAssetDocument,
  serializeCanonicalAsset,
  validateAsset,
  type AssetFieldValue,
  type AssetScopeAxis,
  type CanonicalAsset,
} from "./assets.ts";
import { coreFailure, type AssetResult } from "./failures.ts";
import { codeUnitCompare } from "./ordering.ts";
import type { ResolutionAxis } from "./resolution/resolution-context.ts";
import type {
  AssetCandidate,
  ResolutionSource,
} from "./resolution/resolution-types.ts";

export const SKILL_KINDS = [
  "bounded-operation",
  "procedure",
  "advisory",
  "system-operation",
] as const;
export type SkillKind = (typeof SKILL_KINDS)[number];

export const SKILL_WORKFLOW_RELATIONS = [
  "standalone",
  "workflow-scoped",
] as const;
export type SkillWorkflowRelationKind = (typeof SKILL_WORKFLOW_RELATIONS)[number];

export type SkillWorkflowRelation =
  | { readonly kind: "standalone" }
  | { readonly kind: "workflow-scoped" };

export const SKILL_EXECUTION_PERMISSIONS = [
  "advisory-only",
  "explicit-development",
] as const;
export type SkillExecutionPermission = (typeof SKILL_EXECUTION_PERMISSIONS)[number];

export type CanonicalSkill = {
  readonly asset: CanonicalAsset;
  readonly skillId: SkillId;
  readonly kind: SkillKind;
  readonly displayName: string;
  readonly description: string;
  readonly executionMode: ExecutionMode;
  readonly executionPermission: SkillExecutionPermission;
  readonly workflowRelation: SkillWorkflowRelation;
  readonly priority?: number;
  readonly conflicts: readonly AssetId[];
  readonly activationCondition?: string;
  readonly expectedOutput?: string;
  readonly completionCriteria: readonly string[];
  readonly capabilityDependencies: readonly CapabilityDependency[];
  /**
   * The `metadata.*` entries the Skill contract does not name. `metadata.*` is
   * an open namespace until the type-specific contract validation of #87 lands,
   * so they are carried here and written back verbatim rather than rejected —
   * a Skill authored with its own metadata stays loadable and survives update.
   */
  readonly additionalMetadata: Readonly<Record<string, AssetFieldValue>>;
};

/**
 * The asset-level resolution directives a Skill file may carry.  They are the
 * asset schema's, not the Skill contract's — a Skill's own priority is
 * `metadata.priority` — so a rebuild has to carry them across verbatim instead
 * of deriving them from `SkillInput`.
 */
export type SkillResolutionDirectives = {
  readonly mandatory?: boolean;
  readonly priority?: number;
  readonly mergeMode?: "additive" | "exclusive";
  readonly mergeGroup?: string;
};

export type SkillInput = {
  readonly id: SkillId;
  readonly tier: LoadingTier;
  readonly scope?: Readonly<Partial<Record<AssetScopeAxis, readonly string[]>>>;
  readonly requires?: readonly AssetId[];
  readonly lifecycle?: string;
  readonly displayName: string;
  readonly description: string;
  readonly kind: SkillKind;
  readonly executionMode: ExecutionMode;
  readonly executionPermission: SkillExecutionPermission;
  readonly workflowRelation: SkillWorkflowRelation;
  readonly priority?: number;
  readonly conflicts?: readonly AssetId[];
  readonly activationCondition?: string;
  readonly expectedOutput?: string;
  readonly completionCriteria?: readonly string[];
  readonly capabilityDependencies?: readonly CapabilityDependency[];
  readonly additionalMetadata?: Readonly<Record<string, AssetFieldValue>>;
  readonly resolutionDirectives?: SkillResolutionDirectives;
  readonly body: string;
};

export type SkillPatch = {
  readonly tier?: LoadingTier;
  readonly scope?: Readonly<Partial<Record<AssetScopeAxis, readonly string[]>>>;
  readonly requires?: readonly AssetId[];
  readonly lifecycle?: string | null;
  readonly displayName?: string;
  readonly description?: string;
  readonly kind?: SkillKind;
  readonly executionMode?: ExecutionMode;
  readonly executionPermission?: SkillExecutionPermission;
  readonly workflowRelation?: SkillWorkflowRelation;
  readonly priority?: number | null;
  readonly conflicts?: readonly AssetId[];
  readonly activationCondition?: string | null;
  readonly expectedOutput?: string | null;
  readonly completionCriteria?: readonly string[];
  readonly capabilityDependencies?: readonly CapabilityDependency[];
  readonly additionalMetadata?: Readonly<Record<string, AssetFieldValue>>;
  readonly body?: string;
};

/**
 * A Skill is named by `SkillId` wherever a caller addresses one — the brand the standalone
 * Workflow selection carries — while the Asset layer keys every Asset by `AssetId`. Both brands
 * constrain the value to a non-empty string and nothing else, so crossing between them is a
 * rebrand rather than a parse, and these two functions are the only places it happens.
 */
export const asSkillId = (assetId: AssetId): SkillId => assetId as string as SkillId;
export const skillAssetId = (skillId: SkillId): AssetId => skillId as string as AssetId;

export type SkillCandidateProjection = {
  readonly revision: AssetRevision;
  readonly source: ResolutionSource;
};

const SKILL_METADATA_KEYS = new Set([
  "activation-condition",
  "completion-criteria",
  "conflicts",
  "description",
  "display-name",
  "execution-mode",
  "execution-permission",
  "expected-output",
  "kind",
  "priority",
  "workflow-relation",
]);

type Detail = { readonly path: string[]; readonly code: string; readonly message: string };

const detail = (path: readonly string[], code: string, message: string): Detail => ({
  path: [...path],
  code,
  message,
});

const invalidSkill = (details: readonly Detail[]): AssetResult<never> => ({
  ok: false,
  failure: coreFailure("invalid_request", "The canonical Skill is invalid.", details),
});

const metadataPath = (key: string): readonly string[] => ["document", "frontmatter", `metadata.${key}`];

const scalar = (
  asset: CanonicalAsset,
  key: string,
  required: boolean,
  details: Detail[],
): string | undefined => {
  const value = asset.metadata[key];
  if (value === undefined) {
    if (required) details.push(detail(metadataPath(key), "missing_field", `Skill metadata.${key} is required.`));
    return undefined;
  }
  if (typeof value !== "string") {
    details.push(detail(metadataPath(key), "invalid_value", `Skill metadata.${key} must be a scalar.`));
    return undefined;
  }
  return value;
};

const list = (asset: CanonicalAsset, key: string, details: Detail[]): readonly string[] => {
  const value = asset.metadata[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    details.push(detail(metadataPath(key), "invalid_value", `Skill metadata.${key} must be a list.`));
    return [];
  }
  return value;
};

const member = <Value extends string>(
  value: string | undefined,
  values: readonly Value[],
  key: string,
  details: Detail[],
): Value | undefined => {
  if (value === undefined) return undefined;
  if (!values.includes(value as Value)) {
    details.push(detail(metadataPath(key), "invalid_value", `Skill metadata.${key} has unknown value "${value}".`));
    return undefined;
  }
  return value as Value;
};

/**
 * The authored order is kept. A metadata list is stored as written on both paths, so imposing a
 * canonical order here would make `updateSkillAsset` rewrite the author's file on an edit that
 * never mentioned the list.
 */
const assetIds = (values: readonly string[], key: string, details: Detail[]): readonly AssetId[] => {
  const ids: AssetId[] = [];
  for (const value of values) {
    const parsed = asAssetId(value);
    if (!parsed.ok) {
      details.push(detail(metadataPath(key), "invalid_asset_id", `Skill metadata.${key} contains invalid Asset ID "${value}".`));
    } else {
      ids.push(parsed.value);
    }
  }
  return ids;
};

const optionalMetadata = (metadata: Record<string, string | readonly string[]>, key: string, value: string | undefined): void => {
  if (value !== undefined) metadata[key] = value;
};

/**
 * The serializer demands canonical order in exactly three places — `requires`, each scope axis,
 * and every capability feature list — and `validateAsset` produces all three when it reads the
 * equivalent document. These helpers put the constructed Asset in the same shape, so one value is
 * accepted whichever side it entered through. Duplicates stay the serializer's to reject, which
 * is the answer the loading path gives them too. Metadata lists are deliberately absent: neither
 * path orders them, so a caller's order is the stored order.
 */
const sortedScope = (
  scope: SkillInput["scope"],
): Readonly<Partial<Record<AssetScopeAxis, readonly string[]>>> => {
  const sorted: Partial<Record<AssetScopeAxis, readonly string[]>> = {};
  for (const [axis, values] of Object.entries(scope ?? {}) as [AssetScopeAxis, readonly string[] | undefined][]) {
    if (values !== undefined) sorted[axis] = [...values].sort(codeUnitCompare);
  }
  return sorted;
};

const sortedReference = (reference: CapabilityReference): CapabilityReference =>
  reference.features === undefined
    ? reference
    : { capabilityId: reference.capabilityId, features: [...reference.features].sort(codeUnitCompare) };

const sortedDependencies = (
  dependencies: readonly CapabilityDependency[],
): readonly CapabilityDependency[] =>
  dependencies.map((dependency) => dependency.strength === "fallback"
    ? {
        strength: dependency.strength,
        capability: sortedReference(dependency.capability),
        fallbackFor: sortedReference(dependency.fallbackFor),
      }
    : { strength: dependency.strength, capability: sortedReference(dependency.capability) });

export const parseSkillAsset = (asset: CanonicalAsset): AssetResult<CanonicalSkill> => {
  const details: Detail[] = [];
  if (asset.type !== "skill") {
    details.push(detail(["document", "frontmatter", "type"], "wrong_asset_type", 'Skill Asset type must be "skill".'));
  }
  const additionalMetadata: Record<string, AssetFieldValue> = {};
  for (const [key, value] of Object.entries(asset.metadata)) {
    if (!SKILL_METADATA_KEYS.has(key)) additionalMetadata[key] = value;
  }

  const displayName = scalar(asset, "display-name", true, details);
  const description = scalar(asset, "description", true, details);
  const kind = member(scalar(asset, "kind", true, details), SKILL_KINDS, "kind", details);
  const executionMode = member(
    scalar(asset, "execution-mode", true, details),
    EXECUTION_MODES,
    "execution-mode",
    details,
  );
  const executionPermission = member(
    scalar(asset, "execution-permission", true, details),
    SKILL_EXECUTION_PERMISSIONS,
    "execution-permission",
    details,
  );
  const relationKind = member(
    scalar(asset, "workflow-relation", true, details),
    SKILL_WORKFLOW_RELATIONS,
    "workflow-relation",
    details,
  );
  const priorityValue = scalar(asset, "priority", false, details);
  const priority = priorityValue === undefined ? undefined : Number(priorityValue);
  if (priorityValue !== undefined && (!/^(0|[1-9][0-9]*)$/.test(priorityValue) || !Number.isSafeInteger(priority))) {
    details.push(detail(metadataPath("priority"), "invalid_value", "Skill priority must be a non-negative safe integer."));
  }

  const conflicts = assetIds(list(asset, "conflicts", details), "conflicts", details);
  const completionCriteria = list(asset, "completion-criteria", details);
  const activationCondition = scalar(asset, "activation-condition", false, details);
  const expectedOutput = scalar(asset, "expected-output", false, details);
  if (asset.body.trim() === "") details.push(detail(["document", "body"], "empty_body", "Skill body must not be empty."));

  const workflowScope = asset.scope.workflow;
  let workflowRelation: SkillWorkflowRelation | undefined;
  if (relationKind === "standalone" && workflowScope !== undefined) {
    details.push(detail(["document", "frontmatter", "scope.workflow"], "invalid_skill_relation", "A standalone Skill cannot declare Workflow scope."));
  }
  if (relationKind === "workflow-scoped" && workflowScope === undefined) {
    details.push(detail(["document", "frontmatter", "scope.workflow"], "missing_field", "A workflow-scoped Skill requires Workflow scope."));
  }
  if (relationKind !== undefined) workflowRelation = { kind: relationKind };
  if (executionMode === "development_execution" && executionPermission !== "explicit-development") {
    details.push(detail(
      metadataPath("execution-permission"),
      "invalid_execution_permission",
      "A development execution Skill requires explicit-development permission.",
    ));
  }

  if (details.length > 0 || displayName === undefined || description === undefined || kind === undefined ||
      executionMode === undefined || executionPermission === undefined || workflowRelation === undefined) return invalidSkill(details);

  return {
    ok: true,
    value: {
      asset,
      skillId: asSkillId(asset.id),
      kind,
      displayName,
      description,
      executionMode,
      executionPermission,
      workflowRelation,
      ...(priority === undefined ? {} : { priority }),
      conflicts,
      ...(activationCondition === undefined ? {} : { activationCondition }),
      ...(expectedOutput === undefined ? {} : { expectedOutput }),
      completionCriteria,
      capabilityDependencies: asset.capabilityDependencies ?? [],
      additionalMetadata,
    },
  };
};

export const createSkillAsset = (input: SkillInput): AssetResult<CanonicalAsset> => {
  const metadata: Record<string, string | readonly string[]> = {
    "display-name": input.displayName,
    description: input.description,
    kind: input.kind,
    "execution-mode": input.executionMode,
    "execution-permission": input.executionPermission,
    "workflow-relation": input.workflowRelation.kind,
  };
  if (input.priority !== undefined) metadata.priority = String(input.priority);
  if ((input.conflicts?.length ?? 0) > 0) metadata.conflicts = input.conflicts!;
  optionalMetadata(metadata, "activation-condition", input.activationCondition);
  optionalMetadata(metadata, "expected-output", input.expectedOutput);
  if ((input.completionCriteria?.length ?? 0) > 0) metadata["completion-criteria"] = input.completionCriteria!;
  for (const [key, value] of Object.entries(input.additionalMetadata ?? {})) {
    if (SKILL_METADATA_KEYS.has(key)) {
      return invalidSkill([detail(metadataPath(key), "reserved_key", `Skill metadata.${key} is owned by the Skill contract.`)]);
    }
    metadata[key] = value;
  }

  const asset: CanonicalAsset = {
    schemaVersion: 2,
    id: skillAssetId(input.id),
    type: "skill",
    tier: input.tier,
    metadata,
    scope: sortedScope(input.scope),
    requires: [...(input.requires ?? [])].sort(codeUnitCompare),
    ...(input.capabilityDependencies === undefined || input.capabilityDependencies.length === 0
      ? {}
      : { capabilityDependencies: sortedDependencies(input.capabilityDependencies) }),
    ...(input.lifecycle === undefined ? {} : { lifecycle: input.lifecycle }),
    ...(input.resolutionDirectives?.mandatory === undefined
      ? {}
      : { mandatory: input.resolutionDirectives.mandatory }),
    ...(input.resolutionDirectives?.priority === undefined
      ? {}
      : { priority: input.resolutionDirectives.priority }),
    ...(input.resolutionDirectives?.mergeMode === undefined
      ? {}
      : { mergeMode: input.resolutionDirectives.mergeMode }),
    ...(input.resolutionDirectives?.mergeGroup === undefined
      ? {}
      : { mergeGroup: input.resolutionDirectives.mergeGroup }),
    body: input.body,
  };
  const serialized = serializeCanonicalAsset(asset);
  if (!serialized.ok) return serialized;
  const document = parseAssetDocument(serialized.value);
  if (!document.ok) return document;
  const canonical = validateAsset(document.value);
  if (!canonical.ok) return canonical;
  const parsed = parseSkillAsset(canonical.value);
  return parsed.ok ? { ok: true, value: canonical.value } : parsed;
};

export const updateSkillAsset = (asset: CanonicalAsset, patch: SkillPatch): AssetResult<CanonicalAsset> => {
  const current = parseSkillAsset(asset);
  if (!current.ok) return current;
  const skill = current.value;
  return createSkillAsset({
    id: asSkillId(asset.id),
    tier: patch.tier ?? asset.tier,
    scope: patch.scope ?? asset.scope,
    requires: patch.requires ?? asset.requires,
    ...(patch.lifecycle === null
      ? {}
      : { lifecycle: patch.lifecycle === undefined ? asset.lifecycle : patch.lifecycle }),
    displayName: patch.displayName ?? skill.displayName,
    description: patch.description ?? skill.description,
    kind: patch.kind ?? skill.kind,
    executionMode: patch.executionMode ?? skill.executionMode,
    executionPermission: patch.executionPermission ?? skill.executionPermission,
    workflowRelation: patch.workflowRelation ?? skill.workflowRelation,
    ...(patch.priority === null
      ? {}
      : { priority: patch.priority === undefined ? skill.priority : patch.priority }),
    conflicts: patch.conflicts ?? skill.conflicts,
    ...(patch.activationCondition === null
      ? {}
      : { activationCondition: patch.activationCondition === undefined ? skill.activationCondition : patch.activationCondition }),
    ...(patch.expectedOutput === null
      ? {}
      : { expectedOutput: patch.expectedOutput === undefined ? skill.expectedOutput : patch.expectedOutput }),
    completionCriteria: patch.completionCriteria ?? skill.completionCriteria,
    capabilityDependencies: patch.capabilityDependencies ?? skill.capabilityDependencies,
    additionalMetadata: patch.additionalMetadata ?? skill.additionalMetadata,
    resolutionDirectives: {
      ...(asset.mandatory === undefined ? {} : { mandatory: asset.mandatory }),
      ...(asset.priority === undefined ? {} : { priority: asset.priority }),
      ...(asset.mergeMode === undefined ? {} : { mergeMode: asset.mergeMode }),
      ...(asset.mergeGroup === undefined ? {} : { mergeGroup: asset.mergeGroup }),
    },
    body: patch.body ?? asset.body,
  });
};

const selectorsFromScope = (
  scope: CanonicalAsset["scope"],
): Readonly<Partial<Record<ResolutionAxis, readonly string[]>>> => {
  const selectors: Partial<Record<ResolutionAxis, readonly string[]>> = {};
  if (scope.project !== undefined) selectors.projectId = scope.project;
  if (scope.workflow !== undefined) selectors.workflowId = scope.workflow;
  if (scope.stage !== undefined) selectors.stageId = scope.stage;
  if (scope["task-type"] !== undefined) selectors.taskTypeId = scope["task-type"];
  if (scope.role !== undefined) selectors.roleId = scope.role;
  if (scope.provider !== undefined) selectors.providerId = scope.provider;
  if (scope.runtime !== undefined) selectors.runtimeId = scope.runtime;
  if (scope.model !== undefined) selectors.modelId = scope.model;
  if (scope.directory !== undefined) selectors.directory = scope.directory;
  return selectors;
};

export const projectSkillCandidate = (
  skill: CanonicalSkill,
  projection: SkillCandidateProjection,
): AssetCandidate => ({
  assetId: skill.asset.id,
  revision: projection.revision,
  assetType: "skill",
  loadingTier: skill.asset.tier,
  source: projection.source,
  rule: {
    selectors: selectorsFromScope(skill.asset.scope),
    mandatory: false,
    operation: { kind: "add" },
    ...(skill.priority === undefined ? {} : { explicitPriority: skill.priority }),
    requires: skill.asset.requires,
    ...(skill.capabilityDependencies.length === 0
      ? {}
      : { capabilityDependencies: skill.capabilityDependencies }),
    mergeMode: "additive",
  },
});
