import {
  coreFailure,
  parseWorkflowDefinitionAsset,
  type CoreFailure,
  type MetadataCatalog,
  type ResolvedWorkflowDefinition,
} from "@aacl/core-domain";
import type { AssetId, WorkflowId } from "@aacl/shared";
import {
  type AssetDiagnostic,
  type AssetStore,
  type StoredAsset,
  type StoredAssetSource,
} from "../assets/filesystem-store.ts";
import { withFilePath } from "../internal/diagnostics.ts";

export type WorkflowDefinitionLoadResult =
  | {
      readonly ok: true;
      readonly definition: ResolvedWorkflowDefinition;
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

  const workflowMatches = lookup.matches.filter((stored) => stored.asset.type === "workflow");
  const selected = workflowMatches.length === 1 && lookup.matches.length === 1
    ? workflowMatches[0]
    : undefined;
  if (selected !== undefined) {
    const parsed = parseWorkflowDefinitionAsset(selected.asset, catalog);
    if (!parsed.ok) {
      return failureResult(
        withFilePath(selected.source.rootId, selected.source.relativePath, parsed.failure),
        lookup.matches,
        lookup.failures,
      );
    }
    return {
      ok: true,
      definition: parsed.value,
      source: selected.source,
      assetDiagnostics: lookup.failures,
    };
  }

  if (workflowMatches.length > 0 || lookup.matches.length > 0) {
    if (workflowMatches.length === 0) {
      return failureResult(
        coreFailure("invalid_request", "The requested asset is not a workflow definition.", [{
            path: ["asset", "type"],
            code: "wrong_asset_type",
            message: "The requested asset is not a workflow definition.",
          }]),
        lookup.matches,
        lookup.failures,
      );
    }
    return failureResult(
      coreFailure("conflict", "The workflow definition is not unique."),
      lookup.matches,
      lookup.failures,
    );
  }

  return failureResult(
    coreFailure("not_found", "The workflow definition was not found."),
    lookup.matches,
    lookup.failures,
  );
};
