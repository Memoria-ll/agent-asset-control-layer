import { describe, expect, it } from "vitest";
import type { AssetRevision } from "@aacl/shared";
import {
  DEFAULT_ASSET_TYPE_CONTRACTS,
  parseAssetDocument,
  toAssetCandidate,
  validateAsset,
  type AssetResult,
  type AssetProjectionSource,
  type CanonicalAsset,
} from "../src/index.ts";

const unwrap = <Value>(result: AssetResult<Value>): Value => {
  if (!result.ok) throw new Error(result.failure.message);
  return result.value;
};

const assetFromDocument = (source: string): CanonicalAsset =>
  unwrap(validateAsset(unwrap(parseAssetDocument(source))));

const origin: AssetProjectionSource = {
  revision: "sha256:projection" as AssetRevision,
  source: { layer: "project", sourceId: "source-projection" },
};

const assetDocument = (id: string, type: string, fields = ""): string => `---
id: ${id}
type: ${type}
schema-version: 2
tier: core
${fields}---
body
`;

describe("asset candidate projection", () => {
  it.each([
    ["project", "projectId"],
    ["workflow", "workflowId"],
    ["stage", "stageId"],
    ["task-type", "taskTypeId"],
    ["role", "roleId"],
    ["provider", "providerId"],
    ["runtime", "runtimeId"],
    ["model", "modelId"],
    ["directory", "directory"],
  ] as const)("maps scope.%s to rule.selectors.%s", (assetAxis, resolutionAxis) => {
    const asset = assetFromDocument(
      assetDocument(`projection-${assetAxis}`, "rule", `scope.${assetAxis}: [axis-value]\n`),
    );
    const candidate = unwrap(toAssetCandidate(asset, origin));

    expect(candidate.rule.selectors).toEqual({ [resolutionAxis]: ["axis-value"] });
  });

  it("keeps omitted priority absent and preserves an explicit zero", () => {
    const omitted = unwrap(toAssetCandidate(assetFromDocument(assetDocument("omitted-priority", "rule")), origin));
    const explicit = unwrap(toAssetCandidate(
      assetFromDocument(assetDocument("explicit-priority", "rule", "priority: 0\n")),
      origin,
    ));

    expect(Object.hasOwn(omitted.rule, "explicitPriority")).toBe(false);
    expect(Object.hasOwn(explicit.rule, "explicitPriority")).toBe(true);
    expect(explicit.rule.explicitPriority).toBe(0);
  });

  it("defaults mandatory to false and preserves true", () => {
    const omitted = unwrap(toAssetCandidate(assetFromDocument(assetDocument("omitted-mandatory", "rule")), origin));
    const explicit = unwrap(toAssetCandidate(
      assetFromDocument(assetDocument("explicit-mandatory", "rule", "mandatory: true\n")),
      origin,
    ));

    expect(omitted.rule.mandatory).toBe(false);
    expect(explicit.rule.mandatory).toBe(true);
  });

  it("reads the merge default from the supplied contract registry", () => {
    let defaultModeReads = 0;
    const contracts = {
      ...DEFAULT_ASSET_TYPE_CONTRACTS,
      rule: {
        ...DEFAULT_ASSET_TYPE_CONTRACTS.rule,
        mergePolicy: {
          allowsExclusive: DEFAULT_ASSET_TYPE_CONTRACTS.rule.mergePolicy.allowsExclusive,
          get defaultMode() {
            defaultModeReads += 1;
            return "additive" as const;
          },
        },
      },
    };
    const candidate = unwrap(toAssetCandidate(
      assetFromDocument(assetDocument("custom-contract", "rule")),
      origin,
      contracts,
    ));

    expect(candidate.rule.mergeMode).toBe("additive");
    expect(defaultModeReads).toBe(1);
  });

  it("uses add as the operation and omits capability dependencies", () => {
    const candidate = unwrap(toAssetCandidate(assetFromDocument(assetDocument("operation", "rule")), origin));

    expect(candidate.rule.operation).toEqual({ kind: "add" });
    expect(Object.hasOwn(candidate.rule, "capabilityDependencies")).toBe(false);
  });

  it("does not copy non-candidate asset fields", () => {
    const candidate = unwrap(toAssetCandidate(assetFromDocument(assetDocument(
      "field-boundary",
      "rule",
      "metadata.owner: team\nlifecycle: active\n",
    )), origin));

    expect(candidate).not.toHaveProperty("body");
    expect(candidate).not.toHaveProperty("metadata");
    expect(candidate).not.toHaveProperty("lifecycle");
    expect(candidate).not.toHaveProperty("schemaVersion");
    expect(candidate.rule).not.toHaveProperty("body");
    expect(candidate.rule).not.toHaveProperty("metadata");
    expect(candidate.rule).not.toHaveProperty("lifecycle");
    expect(candidate.rule).not.toHaveProperty("schemaVersion");
  });

  it("rejects an exclusive merge for role and accepts it for rule", () => {
    const role = toAssetCandidate(assetFromDocument(assetDocument(
      "exclusive-role",
      "role",
      "merge-mode: exclusive\nmerge-group: roles\n",
    )), origin);
    const rule = toAssetCandidate(assetFromDocument(assetDocument(
      "exclusive-rule",
      "rule",
      "merge-mode: exclusive\nmerge-group: rules\n",
    )), origin);

    expect(role).toMatchObject({
      ok: false,
      failure: {
        code: "invalid_request",
        details: [{ code: "merge_mode_not_allowed", path: ["asset", "exclusive-role", "merge-mode"] }],
      },
    });
    expect(rule).toMatchObject({ ok: true, value: { rule: { mergeMode: "exclusive", mergeGroup: "rules" } } });
  });

  it("uses a supplied registry to allow an otherwise disallowed exclusive merge", () => {
    const contracts = {
      ...DEFAULT_ASSET_TYPE_CONTRACTS,
      role: {
        ...DEFAULT_ASSET_TYPE_CONTRACTS.role,
        mergePolicy: { ...DEFAULT_ASSET_TYPE_CONTRACTS.role.mergePolicy, allowsExclusive: true },
      },
    };
    const result = toAssetCandidate(assetFromDocument(assetDocument(
      "custom-exclusive-role",
      "role",
      "merge-mode: exclusive\nmerge-group: roles\n",
    )), origin, contracts);

    expect(result.ok).toBe(true);
  });

  it("excludes a candidate whose supplied contract disallows the add operation", () => {
    const contracts = {
      ...DEFAULT_ASSET_TYPE_CONTRACTS,
      rule: { ...DEFAULT_ASSET_TYPE_CONTRACTS.rule, allowedOperationKinds: ["override", "disable"] as const },
    };
    const result = toAssetCandidate(assetFromDocument(assetDocument("no-add", "rule")), origin, contracts);

    expect(result).toMatchObject({
      ok: false,
      failure: {
        code: "invalid_request",
        details: [{ code: "operation_not_allowed", path: ["asset", "no-add", "operation"] }],
      },
    });
  });

  it("binds an asset stored in a project root to that project", () => {
    const candidate = unwrap(toAssetCandidate(
      assetFromDocument(assetDocument("owned-rule", "rule")),
      { ...origin, owningProjectId: "project-one" },
    ));

    expect(candidate.rule.selectors).toEqual({ projectId: ["project-one"] });
  });

  it("intersects a declared project scope with the owning project", () => {
    const candidate = unwrap(toAssetCandidate(
      assetFromDocument(assetDocument("narrowed-rule", "rule", "scope.project: [project-one, project-two]\n")),
      { ...origin, owningProjectId: "project-one" },
    ));

    expect(candidate.rule.selectors).toEqual({ projectId: ["project-one"] });
  });

  it("excludes a declared project scope that omits the owning project", () => {
    const result = toAssetCandidate(
      assetFromDocument(assetDocument("foreign-rule", "rule", "scope.project: [project-two]\n")),
      { ...origin, owningProjectId: "project-one" },
    );

    expect(result).toMatchObject({
      ok: false,
      failure: {
        code: "invalid_request",
        details: [{ code: "project_scope_conflict", path: ["asset", "foreign-rule", "scope.project"] }],
      },
    });
  });

  it("leaves the project axis to the frontmatter when the origin names no owning project", () => {
    const declared = unwrap(toAssetCandidate(
      assetFromDocument(assetDocument("global-declared", "rule", "scope.project: [project-two]\n")),
      origin,
    ));
    const omitted = unwrap(toAssetCandidate(assetFromDocument(assetDocument("global-omitted", "rule")), origin));

    expect(declared.rule.selectors).toEqual({ projectId: ["project-two"] });
    expect(Object.hasOwn(omitted.rule.selectors, "projectId")).toBe(false);
  });
});
