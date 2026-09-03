import type { AssetType } from "@aacl/shared";
import type { ResolutionOperation } from "./scope-resolver.ts";

/**
 * The operation vocabulary a type contract may allow, derived from the resolver's
 * own operation shape so the two cannot drift.
 */
export type AssetOperationKind = ResolutionOperation["kind"];

/**
 * What a resolved candidate of this type means to the processing downstream of
 * resolution.  It is a classification, not an instruction: nothing in this
 * package loads a body or starts a runtime.
 */
export type AssetTypeExecutionProfile =
  | "instruction-body"
  | "runtime-callable"
  | "workflow-definition"
  | "catalog-definition"
  | "policy-input"
  | "guardrail-input";

export type AssetTypeMergePolicy = {
  readonly defaultMode: "additive";
  /**
   * Whether a candidate of this type may declare `mergeMode: "exclusive"`.
   * An additive-only type must not be collapsed to a single winner: a policy or
   * guardrail floor that one candidate can hide is not a floor.
   */
  readonly allowsExclusive: boolean;
};

export type AssetTypeContract = {
  readonly allowedOperationKinds: readonly AssetOperationKind[];
  readonly mergePolicy: AssetTypeMergePolicy;
  readonly executionProfile: AssetTypeExecutionProfile;
  readonly allowsCapabilityDependencies: boolean;
};

/**
 * The registry keyed by asset type.  A `Record` over the closed `AssetType`
 * union is what makes coverage a compile-time property: a type added to
 * `ASSET_TYPES` without a contract fails to build.  It is deliberately not a
 * `Map` and the contract carries no `assetType` member of its own — the key is
 * the single declaration of which type a contract belongs to, so a registry
 * whose key and contract disagree cannot be written.
 */
export type AssetTypeContractRegistry = Readonly<Record<AssetType, AssetTypeContract>>;

const ALL_OPERATION_KINDS: readonly AssetOperationKind[] = ["add", "override", "disable"];

const contract = (
  allowsExclusive: boolean,
  executionProfile: AssetTypeExecutionProfile,
  allowsCapabilityDependencies: boolean,
): AssetTypeContract => ({
  allowedOperationKinds: ALL_OPERATION_KINDS,
  mergePolicy: { defaultMode: "additive", allowsExclusive },
  executionProfile,
  allowsCapabilityDependencies,
});

export const DEFAULT_ASSET_TYPE_CONTRACTS: AssetTypeContractRegistry = {
  rule: contract(true, "instruction-body", false),
  knowledge: contract(true, "instruction-body", false),
  skill: contract(true, "runtime-callable", true),
  workflow: contract(true, "workflow-definition", false),
  role: contract(false, "catalog-definition", false),
  "task-type": contract(false, "catalog-definition", false),
  policy: contract(false, "policy-input", false),
  guardrail: contract(false, "guardrail-input", false),
};
