import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseResolveRequest } from "@aacl/shared";
import type { SkillId } from "@aacl/shared";
import {
  buildCapabilityCatalog,
  createSkillAsset,
  parseAssetDocument,
  resolveScope,
  validateAsset,
  type AssetResult,
  type CanonicalAsset,
  type CapabilityId,
} from "@aacl/core-domain";
import {
  createFilesystemAssetStore,
  toResolutionSnapshot,
  type AssetStore,
  type ManagedAssetRoot,
} from "../src/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const unwrap = <Value>(result: AssetResult<Value>): Value => {
  if (!result.ok) throw new Error(result.failure.message);
  return result.value;
};

const assetFromDocument = (source: string): CanonicalAsset =>
  unwrap(validateAsset(unwrap(parseAssetDocument(source))));

const context = (workflowId: string, stageId: string, roleId: string) => parseResolveRequest({
  context: {
    executionMode: "advisory_preparation",
    workflow: { kind: "selected", workflowId, stageId },
    roleId,
  },
}).context;

const saveAsset = async (
  store: AssetStore,
  rootId: string,
  relativePath: string,
  document: string,
): Promise<void> => {
  const saved = await store.save({
    rootId,
    relativePath,
    asset: assetFromDocument(document),
  });
  expect(saved.ok).toBe(true);
};

describe("filesystem assets to resolution snapshot", () => {
  it("projects saved assets through the resolver input path", async () => {
    const globalDirectory = await mkdtemp(join(tmpdir(), "aacl-resolution-global-"));
    const personalDirectory = await mkdtemp(join(tmpdir(), "aacl-resolution-personal-"));
    const projectDirectory = await mkdtemp(join(tmpdir(), "aacl-resolution-project-"));
    temporaryDirectories.push(globalDirectory, personalDirectory, projectDirectory);
    const roots: readonly ManagedAssetRoot[] = [
      { rootId: "global-root", kind: "global", directory: globalDirectory },
      { rootId: "personal-root", kind: "personal", directory: personalDirectory },
      { rootId: "project-root", kind: "project", projectId: "project-one", directory: projectDirectory },
    ];
    const store = unwrap(createFilesystemAssetStore(roots));

    await saveAsset(store, "global-root", "nested/low.md", `---
id: low-rule
type: rule
schema-version: 2
tier: core
mandatory: false
priority: 1
merge-mode: exclusive
merge-group: review
scope.workflow: [review-flow]
scope.stage: [review]
scope.role: [reviewer]
---
low
`);
    await saveAsset(store, "personal-root", "high.md", `---
id: high-rule
type: rule
schema-version: 2
tier: core
mandatory: true
priority: 9
merge-mode: exclusive
merge-group: review
scope.workflow: [review-flow]
scope.stage: [review]
scope.role: [reviewer]
---
high
`);
    await saveAsset(store, "project-root", "flex.md", `---
id: flexible-rule
type: rule
schema-version: 2
tier: core
scope.role: [implementer, reviewer]
---
flexible
`);
    await saveAsset(store, "global-root", "invalid/bad-role.md", `---
id: invalid-role
type: role
schema-version: 2
tier: core
merge-mode: exclusive
merge-group: review
---
invalid
`);

    const listed = await store.list();
    expect(listed.failures).toHaveLength(0);
    const projection = toResolutionSnapshot(listed.assets);
    expect(projection.snapshot.candidates).toHaveLength(3);
    expect(projection.excluded).toHaveLength(1);
    expect(projection.excluded[0]).toMatchObject({
      source: { kind: "global", rootId: "global-root", relativePath: "invalid/bad-role.md" },
      failure: {
        code: "invalid_request",
        details: [{ code: "merge_mode_not_allowed", path: ["asset", "invalid-role", "merge-mode"] }],
      },
    });

    const sourceByAssetId = new Map(
      projection.snapshot.candidates.map((candidate) => [String(candidate.assetId), candidate.source] as const),
    );
    expect(sourceByAssetId.get("low-rule")).toEqual({
      layer: "global",
      sourceId: JSON.stringify(["global", "global-root", null, "nested/low.md"]),
    });
    expect(sourceByAssetId.get("high-rule")).toEqual({
      layer: "personal",
      sourceId: JSON.stringify(["personal", "personal-root", null, "high.md"]),
    });
    expect(sourceByAssetId.get("flexible-rule")).toEqual({
      layer: "project",
      sourceId: JSON.stringify(["project", "project-root", "project-one", "flex.md"]),
    });
    expect(new Set([...sourceByAssetId.values()].map((source) => source.sourceId))).toHaveLength(3);

    const capabilityContext = {
      catalog: unwrap(buildCapabilityCatalog([])),
      offers: [],
    };
    const mismatched = resolveScope({
      context: context("other-flow", "review", "reviewer"),
      snapshot: projection.snapshot,
      capabilityContext,
    });
    expect(mismatched.ok).toBe(true);
    if (!mismatched.ok) return;
    expect(mismatched.value.evaluations.find((item) => item.candidate.assetId === "low-rule")?.reason).toMatchObject({
      kind: "excluded",
      cause: "scope_mismatch",
    });
    expect(mismatched.value.evaluations.find((item) => item.candidate.assetId === "flexible-rule")?.reason.kind).toBe("included");

    const matched = resolveScope({
      context: context("review-flow", "review", "reviewer"),
      snapshot: projection.snapshot,
      capabilityContext,
    });
    expect(matched.ok).toBe(true);
    if (!matched.ok) return;
    expect(matched.value.outcome).toBe("resolved");
    expect(matched.value.evaluations.find((item) => item.candidate.assetId === "high-rule")?.reason).toMatchObject({
      kind: "included",
      rank: { explicitPriority: 9 },
    });
    expect(matched.value.evaluations.find((item) => item.candidate.assetId === "low-rule")?.reason).toMatchObject({
      kind: "overridden",
      overriddenBy: "high-rule",
      mergeGroup: "review",
    });
    expect(matched.value.evaluations.find((item) => item.candidate.assetId === "high-rule")?.candidate.rule).toMatchObject({
      mandatory: true,
      explicitPriority: 9,
      mergeMode: "exclusive",
      mergeGroup: "review",
      operation: { kind: "add" },
    });

    const implementer = resolveScope({
      context: context("review-flow", "review", "implementer"),
      snapshot: projection.snapshot,
      capabilityContext,
    });
    expect(implementer.ok).toBe(true);
    if (implementer.ok) {
      expect(implementer.value.evaluations.find((item) => item.candidate.assetId === "flexible-rule")?.reason.kind).toBe("included");
    }
  });

  it("keeps a project root's assets out of another project's resolution", async () => {
    const oneDirectory = await mkdtemp(join(tmpdir(), "aacl-resolution-one-"));
    const twoDirectory = await mkdtemp(join(tmpdir(), "aacl-resolution-two-"));
    temporaryDirectories.push(oneDirectory, twoDirectory);
    const store = unwrap(createFilesystemAssetStore([
      { rootId: "one-root", kind: "project", projectId: "project-one", directory: oneDirectory },
      { rootId: "two-root", kind: "project", projectId: "project-two", directory: twoDirectory },
    ]));

    await saveAsset(store, "one-root", "unscoped.md", `---
id: project-one-rule
type: rule
schema-version: 2
tier: core
scope.role: [reviewer]
---
one
`);
    await saveAsset(store, "two-root", "unscoped.md", `---
id: project-two-rule
type: rule
schema-version: 2
tier: core
scope.role: [reviewer]
---
two
`);
    await saveAsset(store, "two-root", "foreign.md", `---
id: foreign-rule
type: rule
schema-version: 2
tier: core
scope.project: [project-one]
---
foreign
`);

    const listed = await store.list();
    expect(listed.failures).toHaveLength(0);
    const projection = toResolutionSnapshot(listed.assets);
    expect(projection.excluded).toMatchObject([{
      source: { kind: "project", projectId: "project-two", relativePath: "foreign.md" },
      failure: { details: [{ code: "project_scope_conflict", path: ["asset", "foreign-rule", "scope.project"] }] },
    }]);

    const selectorsByAssetId = new Map(
      projection.snapshot.candidates.map((candidate) => [String(candidate.assetId), candidate.rule.selectors] as const),
    );
    expect(selectorsByAssetId.get("project-one-rule")).toMatchObject({ projectId: ["project-one"] });
    expect(selectorsByAssetId.get("project-two-rule")).toMatchObject({ projectId: ["project-two"] });

    const resolved = resolveScope({
      context: parseResolveRequest({
        context: {
          executionMode: "advisory_preparation",
          workflow: { kind: "none" },
          projectId: "project-two",
          roleId: "reviewer",
        },
      }).context,
      snapshot: projection.snapshot,
      capabilityContext: { catalog: unwrap(buildCapabilityCatalog([])), offers: [] },
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.evaluations.find((item) => item.candidate.assetId === "project-two-rule")?.reason.kind).toBe("included");
    expect(resolved.value.evaluations.find((item) => item.candidate.assetId === "project-one-rule")?.reason).toMatchObject({
      kind: "excluded",
      cause: "scope_mismatch",
      mismatchedAxes: ["projectId"],
    });
  });

  it("gives a saved Skill the priority and capability dependencies it declared", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aacl-resolution-skill-"));
    temporaryDirectories.push(directory);
    const store = unwrap(createFilesystemAssetStore([
      { rootId: "global-root", kind: "global", directory },
    ]));

    const saved = unwrap(createSkillAsset({
      id: "review-skill" as SkillId,
      tier: "on-demand",
      displayName: "Review Skill",
      description: "Reviews a change.",
      kind: "advisory",
      executionMode: "advisory_preparation",
      executionPermission: "advisory-only",
      workflowRelation: { kind: "standalone" },
      priority: 5,
      capabilityDependencies: [{ strength: "required", capability: { capabilityId: "filesystem-read" as CapabilityId } }],
      body: "Review it.",
    }));
    // The Skill contract authors its priority as metadata, never as the asset directive.
    expect(Object.hasOwn(saved, "priority")).toBe(false);
    expect(saved.metadata.priority).toBe("5");
    expect((await store.save({ rootId: "global-root", relativePath: "skills/review.md", asset: saved })).ok).toBe(true);

    const listed = await store.list();
    expect(listed.failures).toHaveLength(0);
    const projection = toResolutionSnapshot(listed.assets);
    expect(projection.excluded).toHaveLength(0);
    const candidate = projection.snapshot.candidates.find((item) => String(item.assetId) === "review-skill");

    expect(candidate?.rule.explicitPriority).toBe(5);
    expect(candidate?.rule.capabilityDependencies).toEqual([
      { strength: "required", capability: { capabilityId: "filesystem-read" } },
    ]);
  });
});
