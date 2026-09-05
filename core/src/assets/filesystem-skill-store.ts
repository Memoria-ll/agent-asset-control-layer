import {
  coreFailure,
  createSkillAsset,
  parseSkillAsset,
  projectSkillCandidate,
  skillAssetId,
  updateSkillAsset,
  type AssetCandidate,
  type AssetResult,
  type CanonicalSkill,
  type CoreFailure,
  type SkillInput,
  type SkillPatch,
} from "@aacl/core-domain";
import type { AssetRevision, SkillId } from "@aacl/shared";
import { withFilePath } from "../internal/diagnostics.ts";
import { isSavableAssetPath } from "./filesystem-store.ts";
import type {
  AssetDiagnostic,
  AssetStore,
  StoredAsset,
  StoredAssetSource,
} from "./filesystem-store.ts";

export type StoredSkill = {
  readonly skill: CanonicalSkill;
  readonly revision: AssetRevision;
  readonly source: StoredAssetSource;
};

export type SkillLoadResult =
  | {
      readonly ok: true;
      readonly value: StoredSkill;
      readonly assetDiagnostics: readonly AssetDiagnostic[];
    }
  | {
      readonly ok: false;
      readonly failure: CoreFailure;
      readonly matches: readonly StoredAsset[];
      readonly assetDiagnostics: readonly AssetDiagnostic[];
    };

export type SaveSkillInput = {
  readonly rootId: string;
  readonly relativePath: string;
  readonly skill: SkillInput;
  readonly expectedRevision?: AssetRevision;
};

const failureResult = (
  failure: CoreFailure,
  matches: readonly StoredAsset[],
  assetDiagnostics: readonly AssetDiagnostic[],
): SkillLoadResult => ({ ok: false, failure, matches, assetDiagnostics });

const storedSkill = (stored: StoredAsset, skill: CanonicalSkill): StoredSkill => ({
  skill,
  revision: stored.revision,
  source: stored.source,
});

const parseStoredSkill = (stored: StoredAsset): SkillLoadResult => {
  const parsed = parseSkillAsset(stored.asset);
  if (!parsed.ok) {
    return failureResult(
      withFilePath(stored.source.rootId, stored.source.relativePath, parsed.failure),
      [stored],
      [],
    );
  }
  return { ok: true, value: storedSkill(stored, parsed.value), assetDiagnostics: [] };
};

export const loadSkill = async (
  assetStore: AssetStore,
  skillId: SkillId,
): Promise<SkillLoadResult> => {
  const lookup = await assetStore.get(skillAssetId(skillId));
  const unavailable = lookup.failures.find((item) => item.failure.code === "unavailable");
  if (unavailable !== undefined) return failureResult(unavailable.failure, lookup.matches, lookup.failures);

  const skillMatches = lookup.matches.filter((stored) => stored.asset.type === "skill");
  const selected = skillMatches.length === 1 && lookup.matches.length === 1 ? skillMatches[0] : undefined;
  if (selected !== undefined) {
    const parsed = parseStoredSkill(selected);
    return parsed.ok
      ? { ...parsed, assetDiagnostics: lookup.failures }
      : { ...parsed, assetDiagnostics: lookup.failures };
  }

  if (lookup.matches.length > 0) {
    if (skillMatches.length === 0) {
      const wrongType = coreFailure("invalid_request", "The requested asset is not a Skill.", [{
        path: ["asset", "type"],
        code: "wrong_asset_type",
        message: "The requested asset is not a Skill.",
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
      coreFailure("conflict", "The Skill is not unique."),
      lookup.matches,
      lookup.failures,
    );
  }

  return failureResult(coreFailure("not_found", "The Skill was not found."), [], lookup.failures);
};

export const saveSkill = async (
  assetStore: AssetStore,
  input: SaveSkillInput,
): Promise<SkillLoadResult> => {
  const asset = createSkillAsset(input.skill);
  if (!asset.ok) {
    return failureResult(
      withFilePath(input.rootId, input.relativePath, asset.failure),
      [],
      [],
    );
  }
  const saved = await assetStore.save({
    rootId: input.rootId,
    relativePath: input.relativePath,
    asset: asset.value,
    ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
  });
  if (!saved.ok) return failureResult(saved.failure, [], []);
  const parsed = parseStoredSkill(saved.value);
  return parsed;
};

export const updateSkill = async (
  assetStore: AssetStore,
  skillId: SkillId,
  patch: SkillPatch,
): Promise<SkillLoadResult> => {
  const loaded = await loadSkill(assetStore, skillId);
  if (!loaded.ok) return loaded;
  // `list` admits a name the filesystem already holds; `save` admits only a portable one. Writing
  // the listed path straight back answers a hand-authored Skill with `path_outside_root`, which
  // names the wrong problem — the path is inside the root and simply cannot be a write target.
  // Relocating such a Skill needs a store-level move (#124).
  if (!isSavableAssetPath(loaded.value.source.relativePath)) {
    // The failure names the file itself rather than a place inside it, so it is written already
    // rooted instead of going through `withFilePath`, which re-roots a domain failure's paths.
    return failureResult(
      coreFailure("invalid_request", "The Skill is stored under a path the asset store cannot write to.", [{
        path: ["root", loaded.value.source.rootId, "file", loaded.value.source.relativePath],
        code: "nonportable_source_path",
        message: "The Skill must be renamed to a portable path before it can be updated.",
      }]),
      [],
      loaded.assetDiagnostics,
    );
  }
  const updated = updateSkillAsset(loaded.value.skill.asset, patch);
  if (!updated.ok) {
    return failureResult(
      withFilePath(loaded.value.source.rootId, loaded.value.source.relativePath, updated.failure),
      [],
      loaded.assetDiagnostics,
    );
  }
  const saved = await assetStore.save({
    rootId: loaded.value.source.rootId,
    relativePath: loaded.value.source.relativePath,
    asset: updated.value,
    expectedRevision: loaded.value.revision,
  });
  if (!saved.ok) return failureResult(saved.failure, [], loaded.assetDiagnostics);
  const parsed = parseStoredSkill(saved.value);
  return parsed.ok
    ? { ...parsed, assetDiagnostics: loaded.assetDiagnostics }
    : { ...parsed, assetDiagnostics: loaded.assetDiagnostics };
};

export const projectStoredSkillCandidate = (stored: StoredSkill): AssetResult<AssetCandidate> =>
  projectSkillCandidate(stored.skill, {
    revision: stored.revision,
    source: {
      layer: stored.source.kind,
      sourceId: JSON.stringify([
        stored.source.kind,
        stored.source.rootId,
        stored.source.kind === "project" ? stored.source.projectId : null,
        stored.source.relativePath,
      ]),
    },
    ...(stored.source.kind === "project" ? { owningProjectId: stored.source.projectId } : {}),
  });
