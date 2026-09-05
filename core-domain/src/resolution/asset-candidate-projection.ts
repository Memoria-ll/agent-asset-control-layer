import type { AssetRevision } from "@aacl/shared";
import type { CanonicalAsset } from "../assets.ts";
import { coreFailure, type AssetResult } from "../failures.ts";
import {
  DEFAULT_ASSET_TYPE_CONTRACTS,
  type AssetOperationKind,
  type AssetTypeContractRegistry,
} from "./asset-type-contracts.ts";
import type {
  AssetCandidate,
  ResolutionMerge,
  ResolutionRule,
  ResolutionSource,
} from "./resolution-types.ts";
import type { ResolutionAxis } from "./resolution-context.ts";

export type AssetProjectionSource = {
  readonly revision: AssetRevision;
  readonly source: ResolutionSource;
  /**
   * The project that owns the file this asset was read from, when it came from
   * a project root.  The on-disk location is itself an applicability condition:
   * without it a file stored under project A is a candidate for project B, and
   * the frontmatter alone cannot say otherwise.
   */
  readonly owningProjectId?: string;
};

/** The single operation this projection can produce; `overrides` / `disables` are #4's. */
const PROJECTED_OPERATION_KIND: AssetOperationKind = "add";

const detail = (path: readonly string[], code: string, message: string) => ({
  path: [...path],
  code,
  message,
});

const projectionFailure = (
  code: string,
  path: readonly string[],
  message: string,
): AssetResult<never> => ({
  ok: false,
  failure: coreFailure("invalid_request", message, [detail(path, code, message)]),
});

export const toAssetCandidate = (
  asset: CanonicalAsset,
  origin: AssetProjectionSource,
  contracts: AssetTypeContractRegistry = DEFAULT_ASSET_TYPE_CONTRACTS,
): AssetResult<AssetCandidate> => {
  const contract = contracts[asset.type];
  if (!contract.allowedOperationKinds.includes(PROJECTED_OPERATION_KIND)) {
    return projectionFailure(
      "operation_not_allowed",
      ["asset", asset.id, "operation"],
      "The asset type does not allow this operation.",
    );
  }
  const resolvedMergeMode = asset.mergeMode ?? contract.mergePolicy.defaultMode;
  if (resolvedMergeMode === "exclusive" && asset.mergeGroup === undefined) {
    return projectionFailure(
      "invalid_merge_group",
      ["asset", asset.id, "merge-group"],
      "Exclusive merge mode requires a merge group.",
    );
  }
  if (resolvedMergeMode === "exclusive" && !contract.mergePolicy.allowsExclusive) {
    return projectionFailure(
      "merge_mode_not_allowed",
      ["asset", asset.id, "merge-mode"],
      "The asset type does not allow an exclusive merge.",
    );
  }
  const capabilityDependencies = asset.capabilityDependencies ?? [];
  if (capabilityDependencies.length > 0 && !contract.allowsCapabilityDependencies) {
    return projectionFailure(
      "capability_dependencies_not_allowed",
      ["asset", asset.id, "capability"],
      "The asset type does not allow capability dependencies.",
    );
  }

  const declaredProjects = asset.scope.project;
  const owningProjectId = origin.owningProjectId;
  const projectIds = owningProjectId === undefined
    ? declaredProjects
    : declaredProjects === undefined
      ? [owningProjectId]
      : declaredProjects.filter((projectId) => projectId === owningProjectId);
  if (owningProjectId !== undefined && projectIds !== undefined && projectIds.length === 0) {
    return projectionFailure(
      "project_scope_conflict",
      ["asset", asset.id, "scope.project"],
      "The declared project scope excludes the project the asset is stored in.",
    );
  }

  const selectors: Partial<Record<ResolutionAxis, readonly string[]>> = {
    ...(projectIds === undefined ? {} : { projectId: projectIds }),
    ...(asset.scope.workflow === undefined ? {} : { workflowId: asset.scope.workflow }),
    ...(asset.scope.stage === undefined ? {} : { stageId: asset.scope.stage }),
    ...(asset.scope["task-type"] === undefined ? {} : { taskTypeId: asset.scope["task-type"] }),
    ...(asset.scope.role === undefined ? {} : { roleId: asset.scope.role }),
    ...(asset.scope.provider === undefined ? {} : { providerId: asset.scope.provider }),
    ...(asset.scope.runtime === undefined ? {} : { runtimeId: asset.scope.runtime }),
    ...(asset.scope.model === undefined ? {} : { modelId: asset.scope.model }),
    ...(asset.scope.directory === undefined ? {} : { directory: asset.scope.directory }),
  };

  const merge: ResolutionMerge = resolvedMergeMode === "exclusive"
    ? { mergeMode: "exclusive", mergeGroup: asset.mergeGroup as string }
    : asset.mergeGroup === undefined
      ? { mergeMode: "additive" }
      : { mergeMode: "additive", mergeGroup: asset.mergeGroup };
  const rule: ResolutionRule = {
    selectors,
    mandatory: asset.mandatory ?? false,
    operation: { kind: PROJECTED_OPERATION_KIND },
    ...(Object.hasOwn(asset, "priority") ? { explicitPriority: asset.priority as number } : {}),
    requires: asset.requires,
    ...(capabilityDependencies.length === 0 ? {} : { capabilityDependencies }),
    ...merge,
  };

  return {
    ok: true,
    value: {
      assetId: asset.id,
      revision: origin.revision,
      assetType: asset.type,
      loadingTier: asset.tier,
      source: origin.source,
      rule,
    },
  };
};
