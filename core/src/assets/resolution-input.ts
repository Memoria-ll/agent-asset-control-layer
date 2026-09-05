import {
  parseSkillAsset,
  toAssetCandidate,
  type AssetCandidate,
  type AssetTypeContractRegistry,
  type CanonicalAsset,
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

/**
 * A Skill authors its priority as `metadata.priority`, which the asset schema's
 * own `priority` directive does not mirror.  Both are readable on one file, so
 * the type-specific value is resolved here and wins — otherwise a saved Skill
 * ranks as if it declared no priority at all.
 */
const withTypeSpecificDirectives = (asset: CanonicalAsset): CanonicalAsset => {
  if (asset.type !== "skill") return asset;
  const skill = parseSkillAsset(asset);
  if (!skill.ok || skill.value.priority === undefined) return asset;
  return { ...asset, priority: skill.value.priority };
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
      withTypeSpecificDirectives(stored.asset),
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
