import type { AssetId, AssetRevision, AssetType, CoreErrorDetail, DegradedInfo, LoadingTier, ResolutionScopeInput } from "@aacl/shared";
import type { AssetTypeContractRegistry } from "./asset-type-contracts.ts";
import type { CapabilityDegradation, CapabilityDependency, CapabilityId, CapabilityResolutionContext } from "./capabilities.ts";
import type { ResolutionAxis, ResolutionContext } from "./resolution-context.ts";

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
  readonly capabilityDependencies?: readonly CapabilityDependency[];
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

export type NormalizedCandidate = {
  readonly candidate: AssetCandidate;
};

export type RankedCandidate = NormalizedCandidate & {
  readonly rank: ResolutionRank;
};

export type ScopeMatchDecision =
  | {
      readonly matched: true;
      readonly matchedAxes: readonly ResolutionAxis[];
      readonly rank: ResolutionRank;
    }
  | {
      readonly matched: false;
      readonly mismatchedAxes: readonly ResolutionAxis[];
    };

export type ExclusiveDecision =
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
      readonly degradedInfo?: DegradedInfo;
      readonly degradedCapabilities?: readonly CapabilityDegradation[];
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
        | "requirement_invalid"
        | "capability_unavailable";
      readonly failedRequirements: readonly AssetId[];
      readonly failedCapabilities?: readonly CapabilityId[];
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
    }
  | {
      readonly kind: "capability_failure";
      readonly failedCapabilities: readonly CapabilityId[];
      readonly involvedAssetIds: readonly AssetId[];
    };

export type ResolveScopeInput = {
  readonly scope: ResolutionScopeInput;
  readonly snapshot: ResolutionSnapshot;
  readonly contracts?: AssetTypeContractRegistry;
  readonly capabilityContext?: CapabilityResolutionContext;
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

export type CandidateState = {
  readonly candidate: AssetCandidate;
  matched: boolean;
  reason: CandidateReason;
  rank?: ResolutionRank;
};

export type DependencyCause =
  | "missing_requirement"
  | "requirement_out_of_scope"
  | "requirement_disabled"
  | "requirement_overridden"
  | "requirement_cycle"
  | "requirement_invalid"
  | "capability_unavailable";

export type DependencyOutcome =
  | {
      readonly ok: true;
      readonly degradedInfo?: DegradedInfo;
      readonly degradedCapabilities?: readonly CapabilityDegradation[];
    }
  | {
      readonly ok: false;
      readonly cause: DependencyCause;
      readonly failedRequirements: readonly AssetId[];
      readonly failedCapabilities?: readonly CapabilityId[];
      readonly cycleIds?: readonly AssetId[];
      readonly nonCycleFailedRequirements: readonly AssetId[];
    };
