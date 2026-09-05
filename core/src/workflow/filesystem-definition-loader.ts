import {
  coreFailure,
  parseWorkflowDefinitionAsset,
  type AssetResult,
  type CoreFailure,
  type MetadataCatalog,
  type ResolvedWorkflowDefinition,
} from "@aacl/core-domain";
import type { AssetId, WorkflowId } from "@aacl/shared";
import type { AssetRevision } from "@aacl/shared";
import {
  type AssetDiagnostic,
  type AssetStore,
  type StoredAsset,
  type StoredAssetSource,
} from "../assets/filesystem-store.ts";
import { unresolvedOperationFailure, withFilePath } from "../internal/diagnostics.ts";

export type WorkflowDefinitionLoadResult =
  | {
      readonly ok: true;
      readonly definition: ResolvedWorkflowDefinition;
      readonly revision: AssetRevision;
      readonly source: StoredAssetSource;
      readonly assetDiagnostics: readonly AssetDiagnostic[];
    }
  | {
      readonly ok: false;
      readonly failure: CoreFailure;
      readonly matches: readonly StoredAsset[];
      readonly assetDiagnostics: readonly AssetDiagnostic[];
    };

const failureResult = (
  failure: CoreFailure,
  matches: readonly StoredAsset[],
  assetDiagnostics: readonly AssetDiagnostic[],
): WorkflowDefinitionLoadResult => ({
  ok: false,
  failure,
  matches,
  assetDiagnostics,
});

export type SelectedWorkflowDefinition = {
  readonly definition: ResolvedWorkflowDefinition;
  readonly revision: AssetRevision;
  readonly source: StoredAssetSource;
};

/**
 * Turn the assets carrying one workflow id into the effective definition.
 *
 * Separate from the store lookup so a caller that already holds listed assets —
 * scope resolution, which needs the stage's requirements as context axes — is
 * held to the same uniqueness, asset type and unresolved-operation rules instead
 * of reading a second, laxer set.
 */
export const selectWorkflowDefinition = (
  matches: readonly StoredAsset[],
  catalog: MetadataCatalog,
): AssetResult<SelectedWorkflowDefinition> => {
  const workflowMatches = matches.filter((stored) => stored.asset.type === "workflow");
  const selected = workflowMatches.length === 1 && matches.length === 1
    ? workflowMatches[0]
    : undefined;
  if (selected !== undefined) {
    const unresolvedOperation = unresolvedOperationFailure(selected.asset);
    if (unresolvedOperation !== undefined) {
      return {
        ok: false,
        failure: withFilePath(selected.source.rootId, selected.source.relativePath, unresolvedOperation),
      };
    }
    const parsed = parseWorkflowDefinitionAsset(selected.asset, catalog);
    if (!parsed.ok) {
      return {
        ok: false,
        failure: withFilePath(selected.source.rootId, selected.source.relativePath, parsed.failure),
      };
    }
    return {
      ok: true,
      value: { definition: parsed.value, revision: selected.revision, source: selected.source },
    };
  }

  if (workflowMatches.length > 0 || matches.length > 0) {
    if (workflowMatches.length === 0) {
      const wrongType = coreFailure("invalid_request", "The requested asset is not a workflow definition.", [{
        path: ["asset", "type"],
        code: "wrong_asset_type",
        message: "The requested asset is not a workflow definition.",
      }]);
      // A lone match names the offending file, so its detail path is re-rooted there like every
      // other read of a managed root. Several matches cannot be pointed at a single file.
      const single = matches.length === 1 ? matches[0] : undefined;
      return {
        ok: false,
        failure: single === undefined
          ? wrongType
          : withFilePath(single.source.rootId, single.source.relativePath, wrongType),
      };
    }
    return { ok: false, failure: coreFailure("conflict", "The workflow definition is not unique.") };
  }

  return { ok: false, failure: coreFailure("not_found", "The workflow definition was not found.") };
};

/** Load one uniquely selected workflow asset and resolve its domain definition. */
export const loadWorkflowDefinition = async (
  assetStore: AssetStore,
  workflowId: WorkflowId,
  catalog: MetadataCatalog,
): Promise<WorkflowDefinitionLoadResult> => {
  const lookup = await assetStore.get(workflowId as string as AssetId);
  const unavailable = lookup.failures.find((item) => item.failure.code === "unavailable");
  if (unavailable !== undefined) {
    return failureResult(unavailable.failure, lookup.matches, lookup.failures);
  }

  const selected = selectWorkflowDefinition(lookup.matches, catalog);
  if (!selected.ok) return failureResult(selected.failure, lookup.matches, lookup.failures);
  return {
    ok: true,
    definition: selected.value.definition,
    revision: selected.value.revision,
    source: selected.value.source,
    assetDiagnostics: lookup.failures,
  };
};
