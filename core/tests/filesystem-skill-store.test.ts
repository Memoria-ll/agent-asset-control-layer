import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AssetId, SkillId } from "@aacl/shared";
import {
  buildCapabilityCatalog,
  coreFailure,
  resolveScope,
  toResolutionReasonDto,
  type AssetResult,
  type CapabilityCatalog,
  type CapabilityId,
  type SkillInput,
} from "@aacl/core-domain";
import {
  createFilesystemAssetStore,
  loadSkill,
  projectStoredSkillCandidate,
  saveSkill,
  updateSkill,
} from "../src/index.ts";
import type { AssetStore, SkillLoadResult, StoredSkill } from "../src/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

const unwrap = <Value>(result: AssetResult<Value>): Value => {
  if (!result.ok) throw new Error(result.failure.message);
  return result.value;
};

const fixture = async (): Promise<AssetStore> => {
  const directory = await mkdtemp(join(tmpdir(), "aacl-skill-store-"));
  temporaryDirectories.push(directory);
  return unwrap(createFilesystemAssetStore([{ rootId: "project", kind: "project", projectId: "project-aacl", directory }]));
};

const skillInput = (): SkillInput => ({
  id: "review-change" as SkillId,
  tier: "discoverable",
  scope: { project: ["project-aacl"], role: ["reviewer"] },
  requires: ["review-rule" as AssetId],
  displayName: "Review change",
  description: "Review one bounded change.",
  kind: "bounded-operation",
  executionMode: "advisory_preparation",
  executionPermission: "advisory-only",
  workflowRelation: { kind: "standalone" },
  priority: 20,
  body: "Inspect the selected change and report findings.",
});

const expectStored = (result: SkillLoadResult): StoredSkill => {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.failure.message);
  return result.value;
};

const capabilityCatalog = (ids: readonly string[]): CapabilityCatalog => unwrap(buildCapabilityCatalog(ids.map((id) => ({
  capabilityId: id as CapabilityId,
  displayName: id,
  features: [],
}))));

describe("filesystem Skill store", () => {
  it("saves, reloads, and edits a typed Skill through the generic AssetStore", async () => {
    const store = await fixture();
    const saved = expectStored(await saveSkill(store, {
      rootId: "project",
      relativePath: "skills/review-change.md",
      skill: skillInput(),
    }));

    expect(saved.source).toEqual({
      rootId: "project",
      kind: "project",
      projectId: "project-aacl",
      relativePath: "skills/review-change.md",
    });
    expect(saved.revision).toMatch(/^sha256:[a-f0-9]{64}$/);

    const loaded = await loadSkill(store, "review-change" as SkillId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(loaded.failure.message);
    expect(loaded.value.skill.displayName).toBe("Review change");
    expect(loaded.value.revision).toBe(saved.revision);

    const updated = await updateSkill(store, "review-change" as SkillId, {
      displayName: "Review selected change",
      priority: null,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) throw new Error(updated.failure.message);
    expect(updated.value.skill.displayName).toBe("Review selected change");
    expect(updated.value.skill.priority).toBeUndefined();
    expect(updated.value.revision).not.toBe(saved.revision);
    expect(updated.value.source).toEqual(saved.source);
  });

  it("refuses to update a Skill the store cannot write back to", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aacl-skill-store-"));
    temporaryDirectories.push(directory);
    const store = unwrap(createFilesystemAssetStore([
      { rootId: "project", kind: "project", projectId: "project-aacl", directory },
    ]));
    await mkdir(join(directory, "skills"), { recursive: true });
    await writeFile(join(directory, "skills", "CON.md"), `---
schema-version: 3
operation: add
id: reserved-name-skill
type: skill
tier: on-demand
metadata.description: Lives under a name Windows reserves.
metadata.display-name: Reserved name Skill
metadata.execution-mode: advisory_preparation
metadata.execution-permission: advisory-only
metadata.kind: advisory
metadata.workflow-relation: standalone
---
Report advice.
`, "utf8");

    const loaded = expectStored(await loadSkill(store, "reserved-name-skill" as SkillId));
    expect(loaded.source.relativePath).toBe("skills/CON.md");

    const updated = await updateSkill(store, "reserved-name-skill" as SkillId, { displayName: "Renamed" });
    expect(updated.ok).toBe(false);
    if (updated.ok) throw new Error("Expected failure.");
    expect(updated.failure.details).toContainEqual(expect.objectContaining({
      path: ["root", "project", "file", "skills/CON.md"],
      code: "nonportable_source_path",
    }));
  });

  it("returns typed validation details with the target file path", async () => {
    const store = await fixture();
    const result = await saveSkill(store, {
      rootId: "project",
      relativePath: "skills/empty.md",
      skill: { ...skillInput(), id: "empty-skill" as SkillId, body: "" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure.");
    expect(result.failure.details).toContainEqual(expect.objectContaining({
      path: ["root", "project", "file", "skills/empty.md", "body"],
      code: "empty_body",
    }));
  });

  it("distinguishes a wrong Asset type from a missing Skill", async () => {
    const store = await fixture();
    const wrongType = await store.save({
      rootId: "project",
      relativePath: "rules/review-change.md",
      asset: {
        schemaVersion: 3,
        id: "review-change" as AssetId,
        type: "rule",
        tier: "core",
        operation: "add",
        metadata: {},
        scope: {},
        requires: [],
        body: "Rule body.",
      },
    });
    expect(wrongType.ok).toBe(true);

    const wrongTypeResult = await loadSkill(store, "review-change" as SkillId);
    expect(wrongTypeResult.ok).toBe(false);
    if (!wrongTypeResult.ok) {
      expect(wrongTypeResult.failure.details?.[0]).toEqual(expect.objectContaining({
        path: ["root", "project", "file", "rules/review-change.md", "asset", "type"],
        code: "wrong_asset_type",
      }));
    }

    const missing = await loadSkill(store, "missing-skill" as SkillId);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.failure.code).toBe("not_found");
  });

  it("preserves a compare-and-swap conflict from the generic store", async () => {
    const store = await fixture();
    expectStored(await saveSkill(store, {
      rootId: "project",
      relativePath: "skills/review-change.md",
      skill: skillInput(),
    }));
    const conflictingStore: AssetStore = {
      list: store.list,
      get: store.get,
      save: async () => ({
        ok: false,
        failure: coreFailure("conflict", "The revision changed.", [{
          path: ["file", "skills/review-change.md"],
          code: "target_identity_mismatch",
          message: "The revision changed.",
        }]),
      }),
    };

    const result = await updateSkill(conflictingStore, "review-change" as SkillId, { displayName: "Changed" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("conflict");
      expect(result.failure.details?.[0]?.code).toBe("target_identity_mismatch");
    }
  });

  it("carries a saved Skill through the production projector and Resolver availability", async () => {
    const store = await fixture();
    const saved = expectStored(await saveSkill(store, {
      rootId: "project",
      relativePath: "skills/browser-review.md",
      skill: {
        ...skillInput(),
        id: "browser-review" as SkillId,
        requires: [],
        capabilityDependencies: [{
          strength: "optional",
          capability: { capabilityId: "browser-dom" as CapabilityId },
        }],
      },
    }));
    const reloaded = expectStored(await loadSkill(store, "browser-review" as SkillId));
    const candidate = unwrap(projectStoredSkillCandidate(reloaded));
    const result = unwrap(resolveScope({
      context: {
        executionMode: "advisory_preparation",
        workflow: { kind: "none" },
        projectId: "project-aacl",
        roleId: "reviewer",
      },
      snapshot: { candidates: [candidate] },
      capabilityContext: { catalog: capabilityCatalog(["browser-dom"]), offers: [] },
    }));

    expect(result.evaluations).toHaveLength(1);
    expect(result.evaluations[0]?.candidate.revision).toBe(saved.revision);
    expect(result.evaluations[0]?.candidate.source).toEqual({
      layer: "project",
      sourceId: '["project","project","project-aacl","skills/browser-review.md"]',
    });
    expect(result.evaluations[0]?.reason).toMatchObject({
      kind: "included",
      degradedCapabilities: [{ capabilityId: "browser-dom", strength: "optional" }],
      degradedInfo: { reasons: [expect.stringContaining("browser-dom")] },
    });

    expectStored(await saveSkill(store, {
      rootId: "project",
      relativePath: "skills/screenshot-review.md",
      skill: {
        ...skillInput(),
        id: "screenshot-review" as SkillId,
        requires: [],
        capabilityDependencies: [{
          strength: "preferred",
          capability: { capabilityId: "browser-screenshot" as CapabilityId },
        }],
      },
    }));
    const reloadedPreferred = expectStored(await loadSkill(store, "screenshot-review" as SkillId));
    const preferredResult = unwrap(resolveScope({
      context: {
        executionMode: "advisory_preparation",
        workflow: { kind: "none" },
        projectId: "project-aacl",
        roleId: "reviewer",
      },
      snapshot: { candidates: [unwrap(projectStoredSkillCandidate(reloadedPreferred))] },
      capabilityContext: { catalog: capabilityCatalog(["browser-screenshot"]), offers: [] },
    }));
    expect(preferredResult.evaluations[0]?.reason).toMatchObject({
      kind: "included",
      degradedCapabilities: [{ capabilityId: "browser-screenshot", strength: "preferred" }],
    });
  });

  it("keeps StoredSkill operation, Project owner, revision, and source identity in specialized projection", async () => {
    const store = await fixture();
    const saved = expectStored(await saveSkill(store, {
      rootId: "project",
      relativePath: "skills/disable-review.md",
      skill: {
        ...skillInput(),
        id: "disable-review" as SkillId,
        scope: {},
        requires: [],
        resolutionDirectives: { operation: "disable" },
      },
    }));
    const candidate = unwrap(projectStoredSkillCandidate(expectStored(await loadSkill(store, "disable-review" as SkillId))));
    expect(candidate.revision).toBe(saved.revision);
    expect(candidate.source).toEqual({
      layer: "project",
      sourceId: '["project","project","project-aacl","skills/disable-review.md"]',
    });
    expect(candidate.rule.selectors).toEqual({ projectId: ["project-aacl"] });
    expect(candidate.rule.operation).toEqual({ kind: "disable", targetAssetId: "disable-review" });
  });

  it("preserves required, fallback, and Asset dependency reasons across the saved-Skill path", async () => {
    const store = await fixture();
    expectStored(await saveSkill(store, {
      rootId: "project",
      relativePath: "skills/required-browser.md",
      skill: {
        ...skillInput(),
        id: "required-browser" as SkillId,
        requires: [],
        capabilityDependencies: [{
          strength: "required",
          capability: { capabilityId: "browser" as CapabilityId },
        }],
      },
    }));
    const context = {
      executionMode: "advisory_preparation" as const,
      workflow: { kind: "none" as const },
      projectId: "project-aacl",
      roleId: "reviewer",
    };
    const reloadedRequired = expectStored(await loadSkill(store, "required-browser" as SkillId));
    const withoutContext = unwrap(resolveScope({
      context,
      snapshot: { candidates: [unwrap(projectStoredSkillCandidate(reloadedRequired))] },
    }));
    const requiredReason = withoutContext.evaluations[0]?.reason;
    expect(requiredReason).toMatchObject({
      kind: "unavailable",
      cause: "capability_unavailable",
      failedCapabilities: ["browser"],
    });
    if (requiredReason === undefined) throw new Error("Expected a required capability reason.");
    expect(toResolutionReasonDto(requiredReason)).toMatchObject({
      kind: "unavailable",
      detail: { cause: "capability_unavailable", failedCapabilities: ["browser"] },
    });

    const available = unwrap(resolveScope({
      context,
      snapshot: { candidates: [unwrap(projectStoredSkillCandidate(reloadedRequired))] },
      capabilityContext: {
        catalog: capabilityCatalog(["browser"]),
        offers: [{ capabilityId: "browser" as CapabilityId, features: [], permission: "allowed" }],
      },
    }));
    expect(available.evaluations[0]?.reason).toMatchObject({ kind: "included" });

    expectStored(await saveSkill(store, {
      rootId: "project",
      relativePath: "skills/fallback-browser.md",
      skill: {
        ...skillInput(),
        id: "fallback-browser" as SkillId,
        requires: [],
        capabilityDependencies: [
          { strength: "required", capability: { capabilityId: "browser" as CapabilityId } },
          {
            strength: "fallback",
            capability: { capabilityId: "vision" as CapabilityId },
            fallbackFor: { capabilityId: "browser" as CapabilityId },
          },
        ],
      },
    }));
    const reloadedFallback = expectStored(await loadSkill(store, "fallback-browser" as SkillId));
    const fallbackResult = unwrap(resolveScope({
      context,
      snapshot: { candidates: [unwrap(projectStoredSkillCandidate(reloadedFallback))] },
      capabilityContext: {
        catalog: capabilityCatalog(["browser", "vision"]),
        offers: [{ capabilityId: "vision" as CapabilityId, features: [], permission: "allowed" }],
      },
    }));
    expect(fallbackResult.evaluations[0]?.reason).toMatchObject({
      kind: "included",
      degradedCapabilities: [{
        capabilityId: "browser",
        strength: "required",
        fallbackCapabilityId: "vision",
      }],
      degradedInfo: { reasons: [expect.stringContaining("vision")] },
    });

    expectStored(await saveSkill(store, {
      rootId: "project",
      relativePath: "skills/missing-rule.md",
      skill: {
        ...skillInput(),
        id: "missing-rule-skill" as SkillId,
        requires: ["missing-rule" as AssetId],
      },
    }));
    const reloadedMissingAsset = expectStored(await loadSkill(store, "missing-rule-skill" as SkillId));
    const missingAssetResult = unwrap(resolveScope({
      context,
      snapshot: { candidates: [unwrap(projectStoredSkillCandidate(reloadedMissingAsset))] },
      capabilityContext: { catalog: capabilityCatalog([]), offers: [] },
    }));
    expect(missingAssetResult.evaluations[0]?.reason).toMatchObject({
      kind: "unavailable",
      cause: "missing_requirement",
      failedRequirements: ["missing-rule"],
    });
  });
});
