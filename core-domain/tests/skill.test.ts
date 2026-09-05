import { describe, expect, it } from "vitest";
import type { AssetId, AssetRevision, SkillId } from "@aacl/shared";
import {
  createSkillAsset,
  parseAssetDocument,
  parseSkillAsset,
  projectSkillCandidate,
  serializeCanonicalAsset,
  updateSkillAsset,
  validateAsset,
} from "../src/index.ts";
import type {
  CanonicalAsset,
  CapabilityDependency,
  CapabilityFeatureId,
  CapabilityId,
  SkillInput,
} from "../src/index.ts";

const expectOk = <Value>(result: { readonly ok: boolean; readonly value?: Value; readonly failure?: { readonly message: string } }): Value => {
  expect(result.ok).toBe(true);
  if (!result.ok || result.value === undefined) throw new Error(result.failure?.message ?? "Expected success.");
  return result.value;
};

const parseAsset = (document: string): CanonicalAsset =>
  expectOk(validateAsset(expectOk(parseAssetDocument(document))));

const assetId = (value: string): AssetId => value as AssetId;
const skillId = (value: string): SkillId => value as SkillId;
const capabilityId = (value: string): CapabilityId => value as CapabilityId;
const featureId = (value: string): CapabilityFeatureId => value as CapabilityFeatureId;

const workflowSkillDocument = `---
schema-version: 3
operation: add
id: issue-development
type: skill
tier: discoverable
scope.project: [project-aacl]
scope.workflow: [issue-development]
requires: [issue-development-workflow, safety-rule]
capability.required: [filesystem-read]
capability.optional: [browser-dom]
capability.preferred: [browser-screenshot]
capability.fallback.browser-screenshot: vision-image
capability.features.browser-dom: [accessibility-tree]
capability.fallback-features.browser-screenshot: [png]
metadata.activation-condition: An issue is selected.
metadata.completion-criteria: [Pull request is ready, Verification passes]
metadata.conflicts: [emergency-fix]
metadata.description: Develop one issue through a reviewed workflow.
metadata.display-name: Issue development
metadata.execution-mode: development_execution
metadata.execution-permission: explicit-development
metadata.expected-output: A reviewed pull request.
metadata.kind: bounded-operation
metadata.priority: 50
metadata.workflow-relation: workflow-scoped
---
Perform the bounded issue-development operation.
`;

describe("Canonical Skill", () => {
  it("parses a Workflow-scoped Skill and preserves capability dependencies through serialization", () => {
    const asset = parseAsset(workflowSkillDocument);
    const skill = expectOk(parseSkillAsset(asset));

    expect(skill.kind).toBe("bounded-operation");
    expect(skill.workflowRelation).toEqual({ kind: "workflow-scoped" });
    expect(skill.executionPermission).toBe("explicit-development");
    expect(skill.priority).toBe(50);
    expect(skill.capabilityDependencies).toEqual([
      { strength: "required", capability: { capabilityId: "filesystem-read" } },
      {
        strength: "optional",
        capability: { capabilityId: "browser-dom", features: ["accessibility-tree"] },
      },
      { strength: "preferred", capability: { capabilityId: "browser-screenshot" } },
      {
        strength: "fallback",
        capability: { capabilityId: "vision-image", features: ["png"] },
        fallbackFor: { capabilityId: "browser-screenshot" },
      },
    ]);

    const serialized = expectOk(serializeCanonicalAsset(asset));
    expect(expectOk(serializeCanonicalAsset(parseAsset(serialized)))).toBe(serialized);
  });

  it.each([
    ["bounded-operation", "standalone"],
    ["procedure", "standalone"],
    ["advisory", "standalone"],
    ["system-operation", "standalone"],
  ] as const)("accepts %s with %s relation", (kind, relation) => {
    const asset = parseAsset(`---
schema-version: 3
operation: add
id: sample-skill
type: skill
tier: on-demand
metadata.description: A sample Skill.
metadata.display-name: Sample Skill
metadata.execution-mode: advisory_preparation
metadata.execution-permission: advisory-only
metadata.kind: ${kind}
metadata.workflow-relation: ${relation}
---
Perform the bounded instructions.
`);
    expect(expectOk(parseSkillAsset(asset)).workflowRelation.kind).toBe(relation);
  });

  it("requires named Workflow scope for a workflow-scoped Skill", () => {
    const asset = parseAsset(`---
schema-version: 3
operation: add
id: workflow-review
type: skill
tier: on-demand
metadata.description: Review a Workflow stage.
metadata.display-name: Workflow review
metadata.execution-mode: advisory_preparation
metadata.execution-permission: advisory-only
metadata.kind: advisory
metadata.workflow-relation: workflow-scoped
---
Review the selected Workflow stage.
`);
    const result = parseSkillAsset(asset);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure.");
    expect(result.failure.details).toContainEqual(expect.objectContaining({
      path: ["document", "frontmatter", "scope.workflow"],
      code: "missing_field",
    }));
  });

  it("rejects Workflow scope on a standalone Skill", () => {
    const asset = parseAsset(`---
schema-version: 3
operation: add
id: scoped-standalone
type: skill
tier: on-demand
scope.workflow: [issue-development]
metadata.description: Declares contradictory Workflow applicability.
metadata.display-name: Scoped standalone
metadata.execution-mode: advisory_preparation
metadata.execution-permission: advisory-only
metadata.kind: advisory
metadata.workflow-relation: standalone
---
Review the selected input.
`);
    const result = parseSkillAsset(asset);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure.");
    expect(result.failure.details).toContainEqual(expect.objectContaining({
      path: ["document", "frontmatter", "scope.workflow"],
      code: "invalid_skill_relation",
    }));
  });

  it("requires explicit permission for a development execution Skill", () => {
    const asset = parseAsset(`---
schema-version: 3
operation: add
id: unsafe-development
type: skill
tier: on-demand
metadata.description: Attempts development without explicit permission.
metadata.display-name: Unsafe development
metadata.execution-mode: development_execution
metadata.execution-permission: advisory-only
metadata.kind: bounded-operation
metadata.workflow-relation: standalone
---
Modify the selected repository.
`);
    const result = parseSkillAsset(asset);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure.");
    expect(result.failure.details).toContainEqual(expect.objectContaining({
      path: ["document", "frontmatter", "metadata.execution-permission"],
      code: "invalid_execution_permission",
    }));
  });

  it("carries metadata outside the Skill contract through parse and update", () => {
    const asset = parseAsset(`---
schema-version: 3
operation: add
id: annotated-skill
type: skill
tier: on-demand
metadata.description: Carries its own annotations.
metadata.display-name: Annotated Skill
metadata.execution-mode: advisory_preparation
metadata.execution-permission: advisory-only
metadata.kind: advisory
metadata.owning-team: [platform, tooling]
metadata.review-note: Authored outside the Skill contract.
metadata.workflow-relation: standalone
---
Report advice.
`);
    const skill = expectOk(parseSkillAsset(asset));
    expect(skill.additionalMetadata).toEqual({
      "owning-team": ["platform", "tooling"],
      "review-note": "Authored outside the Skill contract.",
    });

    const updated = expectOk(updateSkillAsset(asset, { description: "Still carries them." }));
    expect(updated.metadata["owning-team"]).toEqual(["platform", "tooling"]);
    expect(expectOk(serializeCanonicalAsset(updated))).toContain("metadata.review-note: Authored outside the Skill contract.");
  });

  it("rejects additional metadata that claims a Skill contract key", () => {
    const result = createSkillAsset({
      id: skillId("reserved-metadata"),
      tier: "on-demand",
      displayName: "Reserved metadata",
      description: "Claims a contract key.",
      kind: "advisory",
      executionMode: "advisory_preparation",
      executionPermission: "advisory-only",
      workflowRelation: { kind: "standalone" },
      additionalMetadata: { kind: "procedure" },
      body: "Report advice.",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure.");
    expect(result.failure.details).toContainEqual(expect.objectContaining({
      path: ["document", "frontmatter", "metadata.kind"],
      code: "reserved_key",
    }));
  });

  it("rejects orphan capability fallback and feature declarations", () => {
    const fallback = validateAsset(expectOk(parseAssetDocument(`---
schema-version: 3
operation: add
id: orphan-fallback
type: skill
tier: on-demand
capability.fallback.browser: vision
---
Body
`)));
    expect(fallback.ok).toBe(false);
    if (fallback.ok) throw new Error("Expected failure.");
    expect(fallback.failure.details?.map(({ code }) => code)).toContain("unknown_fallback_primary");

    const features = validateAsset(expectOk(parseAssetDocument(`---
schema-version: 3
operation: add
id: orphan-features
type: skill
tier: on-demand
capability.features.browser: [dom]
---
Body
`)));
    expect(features.ok).toBe(false);
    if (features.ok) throw new Error("Expected failure.");
    expect(features.failure.details?.map(({ code }) => code)).toContain("unknown_capability_reference");

    const redundant = validateAsset(expectOk(parseAssetDocument(`---
schema-version: 3
operation: add
id: redundant-fallback
type: skill
tier: on-demand
capability.required: [browser]
capability.fallback.browser: browser
---
Body
`)));
    expect(redundant.ok).toBe(false);
    if (redundant.ok) throw new Error("Expected failure.");
    expect(redundant.failure.details?.map(({ code }) => code)).toContain("redundant_fallback");
  });

  it("represents a weaker same-capability fallback without losing either feature set", () => {
    const asset = parseAsset(`---
schema-version: 3
operation: add
id: weaker-browser-fallback
type: skill
tier: on-demand
capability.required: [browser]
capability.fallback.browser: browser
capability.features.browser: [dom, screenshot]
capability.fallback-features.browser: [dom]
metadata.description: Use a weaker browser feature set when screenshots are unavailable.
metadata.display-name: Browser fallback
metadata.execution-mode: advisory_preparation
metadata.execution-permission: advisory-only
metadata.kind: advisory
metadata.workflow-relation: standalone
---
Inspect the browser DOM.
`);
    const skill = expectOk(parseSkillAsset(asset));
    expect(skill.capabilityDependencies).toEqual([
      { strength: "required", capability: { capabilityId: "browser", features: ["dom", "screenshot"] } },
      {
        strength: "fallback",
        capability: { capabilityId: "browser", features: ["dom"] },
        fallbackFor: { capabilityId: "browser", features: ["dom", "screenshot"] },
      },
    ]);
    const serialized = expectOk(serializeCanonicalAsset(asset));
    expect(expectOk(serializeCanonicalAsset(parseAsset(serialized)))).toBe(serialized);
  });

  it("keeps an authored metadata list in its authored order across an unrelated edit", () => {
    const asset = parseAsset(`---
schema-version: 3
operation: add
id: ordered-conflicts
type: skill
tier: on-demand
metadata.completion-criteria: [Second step, First step]
metadata.conflicts: [zeta, alpha]
metadata.description: Declares conflicts in a deliberate order.
metadata.display-name: Ordered conflicts
metadata.execution-mode: advisory_preparation
metadata.execution-permission: advisory-only
metadata.kind: advisory
metadata.workflow-relation: standalone
---
Report advice.
`);
    expect(expectOk(parseSkillAsset(asset)).conflicts).toEqual(["zeta", "alpha"]);

    const updated = expectOk(updateSkillAsset(asset, { description: "Edited elsewhere." }));
    expect(updated.metadata.conflicts).toEqual(["zeta", "alpha"]);
    const serialized = expectOk(serializeCanonicalAsset(updated));
    expect(serialized).toContain("metadata.conflicts: [zeta, alpha]");
    expect(serialized).toContain("metadata.completion-criteria: [Second step, First step]");
  });

  it("normalizes supplied capability feature lists the way a loaded document is normalized", () => {
    const created = expectOk(createSkillAsset({
      id: skillId("unsorted-features"),
      tier: "on-demand",
      displayName: "Unsorted features",
      description: "Supplies feature sets out of order.",
      kind: "advisory",
      executionMode: "advisory_preparation",
      executionPermission: "advisory-only",
      workflowRelation: { kind: "standalone" },
      capabilityDependencies: [
        {
          strength: "required",
          capability: { capabilityId: capabilityId("filesystem"), features: [featureId("write"), featureId("read")] },
        },
        {
          strength: "fallback",
          capability: { capabilityId: capabilityId("workspace"), features: [featureId("write"), featureId("read")] },
          fallbackFor: { capabilityId: capabilityId("filesystem"), features: [featureId("write"), featureId("read")] },
        },
      ],
      body: "Report advice.",
    }));

    const serialized = expectOk(serializeCanonicalAsset(created));
    expect(serialized).toContain("capability.features.filesystem: [read, write]");
    expect(serialized).toContain("capability.fallback-features.filesystem: [read, write]");
  });

  it("normalizes supplied scope values the way a loaded document is normalized", () => {
    const created = expectOk(createSkillAsset({
      id: skillId("unsorted-scope"),
      tier: "on-demand",
      scope: { role: ["reviewer", "author"], project: ["project-b", "project-a"] },
      displayName: "Unsorted scope",
      description: "Supplies scope values out of order.",
      kind: "advisory",
      executionMode: "advisory_preparation",
      executionPermission: "advisory-only",
      workflowRelation: { kind: "standalone" },
      body: "Report advice.",
    }));

    expect(created.scope).toEqual({ project: ["project-a", "project-b"], role: ["author", "reviewer"] });
    const serialized = expectOk(serializeCanonicalAsset(created));
    expect(serialized).toContain("scope.project: [project-a, project-b]");
    expect(serialized).toContain("scope.role: [author, reviewer]");
  });

  it("creates, updates, and projects one Skill without duplicating its identity", () => {
    const capabilityDependencies: readonly CapabilityDependency[] = [{
      strength: "required",
      capability: { capabilityId: capabilityId("filesystem-read"), features: [featureId("text")] },
    }];
    const input: SkillInput = {
      id: skillId("review-change"),
      tier: "discoverable",
      scope: { project: ["project-aacl"], role: ["reviewer"] },
      requires: [assetId("review-rule")],
      lifecycle: "active",
      displayName: "Review change",
      description: "Review a bounded change.",
      kind: "bounded-operation",
      executionMode: "advisory_preparation",
      executionPermission: "advisory-only",
      workflowRelation: { kind: "standalone" },
      priority: 10,
      conflicts: [assetId("write-change")],
      completionCriteria: ["Findings are reported"],
      capabilityDependencies,
      body: "Inspect the selected change.",
    };
    const created = expectOk(createSkillAsset(input));
    const updated = expectOk(updateSkillAsset(created, {
      displayName: "Review selected change",
      priority: null,
    }));
    const skill = expectOk(parseSkillAsset(updated));

    expect(skill.skillId).toBe("review-change");
    expect(skill.displayName).toBe("Review selected change");
    expect(skill.priority).toBeUndefined();
    expect(skill.asset.lifecycle).toBe("active");
    expect(skill.capabilityDependencies).toEqual(capabilityDependencies);

    expect(expectOk(projectSkillCandidate(skill, {
      revision: "sha256:revision" as AssetRevision,
      source: { layer: "project", sourceId: "project-root/skills/review-change.md" },
    }))).toEqual({
      assetId: "review-change",
      revision: "sha256:revision",
      assetType: "skill",
      loadingTier: "discoverable",
      source: { layer: "project", sourceId: "project-root/skills/review-change.md" },
      rule: {
        selectors: { projectId: ["project-aacl"], roleId: ["reviewer"] },
        mandatory: false,
        operation: { kind: "add" },
        requires: ["review-rule"],
        capabilityDependencies,
        mergeMode: "additive",
      },
    });
  });

  it("preserves the asset operation and resolution directives through Skill create/update", () => {
    const created = expectOk(createSkillAsset({
      id: skillId("operation-skill"),
      tier: "on-demand",
      displayName: "Operation Skill",
      description: "Carries operation directives.",
      kind: "advisory",
      executionMode: "advisory_preparation",
      executionPermission: "advisory-only",
      workflowRelation: { kind: "standalone" },
      resolutionDirectives: { operation: "override", mandatory: true, priority: 7, mergeMode: "exclusive", mergeGroup: "review" },
      body: "Apply the operation.",
    }));
    expect(created.operation).toBe("override");
    expect(created.mandatory).toBe(true);
    const updated = expectOk(updateSkillAsset(created, { description: "Updated operation skill." }));
    expect(updated).toMatchObject({ operation: "override", mandatory: true, priority: 7, mergeMode: "exclusive", mergeGroup: "review" });

    const skill = expectOk(parseSkillAsset(updated));
    const personal = projectSkillCandidate(skill, {
      revision: "sha256:personal" as AssetRevision,
      source: { layer: "personal", sourceId: "personal/operation-skill.md" },
    });
    expect(personal).toMatchObject({
      ok: false,
      failure: { details: [{ code: "operation_requires_project_source" }] },
    });

    const wrongOwner = projectSkillCandidate({
      ...skill,
      asset: { ...skill.asset, operation: "add", scope: { project: ["project-one"] } },
    }, {
      revision: "sha256:project" as AssetRevision,
      source: { layer: "project", sourceId: "project/operation-skill.md" },
      owningProjectId: "project-two",
    });
    expect(wrongOwner).toMatchObject({
      ok: false,
      failure: { details: [{ code: "project_scope_conflict" }] },
    });
  });

  it("normalizes capability dependency order in the created Canonical Asset", () => {
    const created = expectOk(createSkillAsset({
      id: skillId("ordered-capabilities"),
      tier: "on-demand",
      displayName: "Ordered capabilities",
      description: "Keeps one canonical dependency order.",
      kind: "advisory",
      executionMode: "advisory_preparation",
      executionPermission: "advisory-only",
      workflowRelation: { kind: "standalone" },
      capabilityDependencies: [
        { strength: "preferred", capability: { capabilityId: capabilityId("zeta") } },
        { strength: "required", capability: { capabilityId: capabilityId("alpha") } },
      ],
      body: "Inspect the available capabilities.",
    }));

    expect(created.capabilityDependencies).toEqual([
      { strength: "required", capability: { capabilityId: "alpha" } },
      { strength: "preferred", capability: { capabilityId: "zeta" } },
    ]);
    expect(expectOk(parseSkillAsset(created)).capabilityDependencies).toEqual(created.capabilityDependencies);
  });

  it("returns failures for malformed runtime capability values instead of throwing or dropping them", () => {
    const base = parseAsset(`---
schema-version: 3
operation: add
id: malformed-capability
type: skill
tier: on-demand
metadata.description: Exercises runtime validation.
metadata.display-name: Malformed capability
metadata.execution-mode: advisory_preparation
metadata.execution-permission: advisory-only
metadata.kind: advisory
metadata.workflow-relation: standalone
---
Inspect input.
`);
    const malformedStrength = {
      ...base,
      capabilityDependencies: [{ strength: "mystery", capability: { capabilityId: "browser" } }],
    } as unknown as CanonicalAsset;
    expect(serializeCanonicalAsset(malformedStrength)).toMatchObject({
      ok: false,
      failure: { details: [{ code: "invalid_capability_strength" }] },
    });

    const malformedReference = {
      ...base,
      capabilityDependencies: [{ strength: "required", capability: null }],
    } as unknown as CanonicalAsset;
    expect(() => serializeCanonicalAsset(malformedReference)).not.toThrow();
    expect(serializeCanonicalAsset(malformedReference)).toMatchObject({
      ok: false,
      failure: { details: [{ code: "invalid_capability_reference" }] },
    });
  });

  it("keeps the asset resolution directives across an unrelated Skill update", () => {
    const asset = parseAsset(`---
schema-version: 3
operation: add
id: directive-skill
type: skill
tier: on-demand
mandatory: true
priority: 3
merge-mode: exclusive
merge-group: review
metadata.description: Carries asset directives.
metadata.display-name: Directive Skill
metadata.execution-mode: advisory_preparation
metadata.execution-permission: advisory-only
metadata.kind: advisory
metadata.workflow-relation: standalone
---
Body.
`);
    expect(asset).toMatchObject({ mandatory: true, priority: 3, mergeMode: "exclusive", mergeGroup: "review" });

    const updated = expectOk(updateSkillAsset(asset, { displayName: "Renamed Skill" }));

    expect(updated).toMatchObject({ mandatory: true, priority: 3, mergeMode: "exclusive", mergeGroup: "review" });
    expect(expectOk(parseSkillAsset(updated)).displayName).toBe("Renamed Skill");
    expect(expectOk(serializeCanonicalAsset(updated))).toContain("merge-group: review");
  });
});
