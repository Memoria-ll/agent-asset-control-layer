import {
  bindingAssetId,
  coreFailure,
  parseBindingAsset,
  toAssetCandidate,
  type AssetResult,
  type CanonicalAsset,
  type AssetTypeContractRegistry,
  type CanonicalBinding,
  type CoreFailure,
} from "@aacl/core-domain";
import type { AssetRevision, BindingId } from "@aacl/shared";
import { withFilePath } from "../internal/diagnostics.ts";
import type {
  AssetDiagnostic,
  AssetStore,
  StoredAsset,
  StoredAssetSource,
} from "./filesystem-store.ts";

/**
 * Stands in for the revision the save has not produced yet. Projection reads it
 * only as an opaque identity, never as a value, so probing with a placeholder
 * asks exactly the question the save needs answered.
 */
const PROJECTION_PROBE_REVISION = "pending-save" as AssetRevision;

export type StoredBinding = {
  readonly binding: CanonicalBinding;
  readonly revision: AssetRevision;
  readonly source: StoredAssetSource;
};

export type BindingLoadResult =
  | {
      readonly ok: true;
      readonly value: StoredBinding;
      readonly assetDiagnostics: readonly AssetDiagnostic[];
    }
  | {
      readonly ok: false;
      readonly failure: CoreFailure;
      readonly matches: readonly StoredAsset[];
      readonly assetDiagnostics: readonly AssetDiagnostic[];
    };

export type SaveBindingInput = {
  readonly rootId: string;
  readonly relativePath: string;
  readonly asset: CanonicalAsset;
  readonly expectedRevision?: AssetRevision;
  /**
   * The registry resolution will use. The save-time guarantee is only worth
   * anything if it answers the same question the resolver will: a registry the
   * caller configures decides which directives a Binding may carry, so probing
   * with the default one lets a save pass that resolution then excludes.
   */
  readonly contracts?: AssetTypeContractRegistry;
};

const failureResult = (
  failure: CoreFailure,
  matches: readonly StoredAsset[],
  assetDiagnostics: readonly AssetDiagnostic[],
): BindingLoadResult => ({ ok: false, failure, matches, assetDiagnostics });

const storedBinding = (stored: StoredAsset, binding: CanonicalBinding): StoredBinding => ({
  binding,
  revision: stored.revision,
  source: stored.source,
});

const parseStoredBinding = (stored: StoredAsset): BindingLoadResult => {
  const parsed = parseBindingAsset(stored.asset);
  if (!parsed.ok) {
    return failureResult(
      withFilePath(stored.source.rootId, stored.source.relativePath, parsed.failure),
      [stored],
      [],
    );
  }
  return { ok: true, value: storedBinding(stored, parsed.value), assetDiagnostics: [] };
};

export const loadBinding = async (
  assetStore: AssetStore,
  bindingId: BindingId,
): Promise<BindingLoadResult> => {
  const lookup = await assetStore.get(bindingAssetId(bindingId));
  const unavailable = lookup.failures.find((item) => item.failure.code === "unavailable");
  if (unavailable !== undefined) return failureResult(unavailable.failure, lookup.matches, lookup.failures);

  const bindingMatches = lookup.matches.filter((stored) => stored.asset.type === "binding");
  const selected = bindingMatches.length === 1 && lookup.matches.length === 1 ? bindingMatches[0] : undefined;
  if (selected !== undefined) {
    const parsed = parseStoredBinding(selected);
    return parsed.ok ? { ...parsed, assetDiagnostics: lookup.failures } : { ...parsed, assetDiagnostics: lookup.failures };
  }

  if (lookup.matches.length > 0) {
    if (bindingMatches.length === 0) {
      const wrongType = coreFailure("invalid_request", "The requested asset is not a Binding.", [{
        path: ["asset", "type"],
        code: "wrong_asset_type",
        message: "The requested asset is not a Binding.",
      }]);
      const single = lookup.matches.length === 1 ? lookup.matches[0] : undefined;
      return failureResult(
        single === undefined
          ? wrongType
          : withFilePath(single.source.rootId, single.source.relativePath, wrongType),
        lookup.matches,
        lookup.failures,
      );
    }
    return failureResult(
      coreFailure("conflict", "The Binding is not unique."),
      lookup.matches,
      lookup.failures,
    );
  }

  return failureResult(coreFailure("not_found", "The Binding was not found."), [], lookup.failures);
};

export const saveBinding = async (
  assetStore: AssetStore,
  input: SaveBindingInput,
): Promise<BindingLoadResult> => {
  const parsed = parseBindingAsset(input.asset);
  if (!parsed.ok) {
    return failureResult(
      withFilePath(input.rootId, input.relativePath, parsed.failure),
      [],
      [],
    );
  }
  // Run the destination through the same projection resolution will: a save that
  // succeeds and then leaves a file resolution can only exclude — the wrong root
  // for an overlay, a merge mode the Binding contract forbids — is worse than a
  // refusal. The destination decides the first of those, not the document, so
  // the check belongs here rather than in `parseBindingAsset`.
  const destination = assetStore.roots.find((root) => root.rootId === input.rootId);
  const projected = toAssetCandidate(
    parsed.value.asset,
    {
      revision: PROJECTION_PROBE_REVISION,
      source: {
        layer: destination?.kind ?? "global",
        sourceId: `${input.rootId}:${input.relativePath}`,
      },
      ...(destination?.kind === "project" ? { owningProjectId: destination.projectId } : {}),
    },
    ...(input.contracts === undefined ? [] : [input.contracts]),
  );
  if (!projected.ok) {
    return failureResult(
      withFilePath(input.rootId, input.relativePath, projected.failure),
      [],
      [],
    );
  }
  const saved = await assetStore.save({
    rootId: input.rootId,
    relativePath: input.relativePath,
    asset: parsed.value.asset,
    ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
  });
  if (!saved.ok) return failureResult(saved.failure, [], []);
  return parseStoredBinding(saved.value);
};
