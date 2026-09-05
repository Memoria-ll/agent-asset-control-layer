import {
  toAssetCandidate,
  type AssetCandidate,
  type AssetTypeContractRegistry,
  type ResolutionSnapshot,
} from "@aacl/core-domain";
import type { AssetDiagnostic, AssetLocation, StoredAsset } from "./filesystem-store.ts";

export type ResolutionInputProjection = {
  readonly snapshot: ResolutionSnapshot;
  readonly excluded: readonly AssetDiagnostic[];
};

const sourceIdFor = (source: StoredAsset["source"]): string => {
  // rootId alone collides within a root, while relativePath alone collides across roots.
  return JSON.stringify([
    source.kind,
    source.rootId,
    source.kind === "project" ? source.projectId : null,
    source.relativePath,
  ]);
};

export const toResolutionSnapshot = (
  storedAssets: readonly StoredAsset[],
  contracts?: AssetTypeContractRegistry,
): ResolutionInputProjection => {
  const candidates: AssetCandidate[] = [];
  const excluded: AssetDiagnostic[] = [];

  for (const stored of storedAssets) {
    const source: AssetLocation = stored.source;
    const projected = toAssetCandidate(
      stored.asset,
      {
        revision: stored.revision,
        source: { layer: stored.source.kind, sourceId: sourceIdFor(stored.source) },
        ...(stored.source.kind === "project" ? { owningProjectId: stored.source.projectId } : {}),
      },
      contracts,
    );
    if (projected.ok) {
      candidates.push(projected.value);
    } else {
      excluded.push({ source, failure: projected.failure });
    }
  }

  return { snapshot: { candidates }, excluded };
};
