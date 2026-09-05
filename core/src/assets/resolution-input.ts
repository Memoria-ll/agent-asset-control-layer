import {
  parseBindingAsset,
  parseSkillAsset,
  toAssetCandidate,
  type AssetCandidate,
  type AssetResult,
  type AssetTypeContractRegistry,
  type CanonicalAsset,
  type ResolutionSnapshot,
} from "@aacl/core-domain";
import type { AssetDiagnostic, AssetLocation, StoredAsset } from "./filesystem-store.ts";

export type ResolutionInputProjection = {
  readonly snapshot: ResolutionSnapshot;
  readonly excluded: readonly AssetDiagnostic[];
};

export const sourceIdFor = (source: StoredAsset["source"]): string => {
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
 *
 * A type-specific parse failure excludes the asset rather than falling back to
 * the generic reading: the generic schema accepts a Skill that names none of
 * its contract metadata, so a candidate no runtime could use would otherwise be
 * reported as included.
 */
const withTypeSpecificDirectives = (asset: CanonicalAsset): AssetResult<CanonicalAsset> => {
  if (asset.type === "binding") {
    const binding = parseBindingAsset(asset);
    return binding.ok ? { ok: true, value: asset } : binding;
  }
  if (asset.type !== "skill") return { ok: true, value: asset };
  const skill = parseSkillAsset(asset);
  if (!skill.ok) return skill;
  const priority = skill.value.priority;
  return { ok: true, value: priority === undefined ? asset : { ...asset, priority } };
};

export const toResolutionSnapshot = (
  storedAssets: readonly StoredAsset[],
  contracts?: AssetTypeContractRegistry,
): ResolutionInputProjection => {
  const candidates: AssetCandidate[] = [];
  const excluded: AssetDiagnostic[] = [];

  for (const stored of storedAssets) {
    const source: AssetLocation = stored.source;
    const resolved = withTypeSpecificDirectives(stored.asset);
    if (!resolved.ok) {
      excluded.push({ source, failure: resolved.failure });
      continue;
    }
    const projected = toAssetCandidate(
      resolved.value,
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
