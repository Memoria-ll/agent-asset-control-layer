import { describe, expect, it } from "vitest";
import { parseResolveRequest } from "@aacl/shared";
import type { AssetId, AssetRevision, AssetType } from "@aacl/shared";
import {
  DEFAULT_ASSET_TYPE_CONTRACTS,
  parseAssetDocument,
  resolveScope,
  toAssetCandidate,
  validateAsset,
} from "../src/index.ts";
import type {
  AssetCandidate,
  AssetTypeContractRegistry,
  AssetTypeExecutionProfile,
  CanonicalAsset,
  CapabilityId,
  ResolutionMerge,
  ResolutionOperation,
  ResolutionSource,
  ResolutionResult,
} from "../src/index.ts";

type GlobOptions = {
  readonly eager?: boolean;
  readonly import?: string;
  readonly query?: string;
};

declare global {
  interface ImportMeta {
    glob<T>(pattern: string, options?: GlobOptions): Record<string, T>;
  }
}

type ResolutionDirectives = {
  readonly mandatory: boolean;
  readonly explicitPriority?: number;
  readonly operation: ResolutionOperation;
  readonly mergeMode: ResolutionMerge["mergeMode"];
  readonly mergeGroup?: string;
};

type FixtureMetadata = {
  readonly revision?: string;
  readonly source?: ResolutionSource;
};

const expectOk = <Value>(result: { readonly ok: boolean; readonly value?: Value; readonly failure?: { readonly message: string } }): Value => {
  expect(result.ok).toBe(true);
  if (!result.ok || result.value === undefined) throw new Error(result.failure?.message ?? "Expected a successful result.");
  return result.value;
};

const assetDocument = (id: string, type: AssetType, fields = ""): string => `---
id: ${id}
type: ${type}
schema-version: 3
operation: add
tier: core
${fields}---
`;

const candidateFromCanonicalAsset = (
  asset: CanonicalAsset,
  directives: ResolutionDirectives,
  fixture: FixtureMetadata = {},
): AssetCandidate => {
  const merge = directives.mergeMode === "exclusive"
    ? { mergeMode: "exclusive" as const, mergeGroup: directives.mergeGroup as string }
    : directives.mergeGroup === undefined
      ? { mergeMode: "additive" as const }
      : { mergeMode: "additive" as const, mergeGroup: directives.mergeGroup };

  const projected = expectOk(toAssetCandidate(asset, {
    revision: (fixture.revision ?? `revision-${asset.id}`) as AssetRevision,
    source: fixture.source ?? { layer: "global", sourceId: `source-${asset.id}` },
  }));
  return {
    ...projected,
    rule: {
      ...projected.rule,
      mandatory: directives.mandatory,
      operation: directives.operation,
      ...(directives.explicitPriority === undefined ? {} : { explicitPriority: directives.explicitPriority }),
      ...merge,
    },
  };
};

const candidateFromDocument = (
  document: string,
  directives: ResolutionDirectives,
  fixture: FixtureMetadata = {},
): AssetCandidate => {
  const parsed = expectOk(parseAssetDocument(document));
  const asset = expectOk(validateAsset(parsed));
  return candidateFromCanonicalAsset(asset, directives, fixture);
};

const add = (mergeGroup?: string): ResolutionDirectives => ({
  mandatory: false,
  operation: { kind: "add" },
  mergeMode: "additive",
  ...(mergeGroup === undefined ? {} : { mergeGroup }),
});

const override = (targetAssetId: string, mergeGroup: string): ResolutionDirectives => ({
  mandatory: false,
  operation: { kind: "override", targetAssetId: targetAssetId as AssetId },
  mergeMode: "additive",
  mergeGroup,
});

const disable = (targetAssetId: string): ResolutionDirectives => ({
  mandatory: false,
  operation: { kind: "disable", targetAssetId: targetAssetId as AssetId },
  mergeMode: "additive",
});

const exclusive = (mergeGroup: string): ResolutionDirectives => ({
  mandatory: false,
  operation: { kind: "add" },
  mergeMode: "exclusive",
  mergeGroup,
});

const resolve = (
  candidates: readonly AssetCandidate[],
  contracts?: AssetTypeContractRegistry,
) => resolveScope({
  context: parseResolveRequest({
    context: { executionMode: "advisory_preparation", workflow: { kind: "none" } },
  }).context,
  snapshot: { candidates },
  ...(contracts === undefined ? {} : { contracts }),
});

const resultValue = (
  candidates: readonly AssetCandidate[],
  contracts?: AssetTypeContractRegistry,
): ResolutionResult => expectOk(resolve(candidates, contracts));

const reason = (result: ResolutionResult, assetId: string) => {
  const evaluation = result.evaluations.find((item) => item.candidate.assetId === assetId);
  if (evaluation === undefined) throw new Error(`Evaluation for ${assetId} was not found.`);
  return evaluation.reason;
};

describe("asset type contracts", () => {
  it("rejects an override between different asset types before changing the target", () => {
    const target = candidateFromDocument(assetDocument("skill-target", "skill"), add("shared-group"));
    const issuer = candidateFromDocument(assetDocument("rule-issuer", "rule"), override("skill-target", "shared-group"));
    const result = resultValue([issuer, target]);

    expect(result.outcome).toBe("conflicted");
    expect(reason(result, "rule-issuer")).toMatchObject({ kind: "excluded", cause: "resolution_conflict" });
    expect(reason(result, "skill-target")).toMatchObject({ kind: "included" });
    expect(result.conflicts).toEqual([{ kind: "asset_type_conflict", involvedAssetIds: ["rule-issuer", "skill-target"] }]);
  });

  it("rejects a disable between different asset types before changing the target", () => {
    const target = candidateFromDocument(assetDocument("guardrail-target", "guardrail"), add());
    const issuer = candidateFromDocument(assetDocument("rule-issuer", "rule"), disable("guardrail-target"));
    const result = resultValue([issuer, target]);

    expect(result.outcome).toBe("conflicted");
    expect(reason(result, "rule-issuer")).toMatchObject({ kind: "excluded", cause: "resolution_conflict" });
    expect(reason(result, "guardrail-target")).toMatchObject({ kind: "included" });
    expect(result.conflicts).toEqual([{ kind: "asset_type_conflict", involvedAssetIds: ["guardrail-target", "rule-issuer"] }]);
  });

  it("rejects a cross-type same-ID override overlay", () => {
    const base = candidateFromDocument(assetDocument("overlay", "rule"), add("overlay-group"), {
      revision: "global-revision",
      source: { layer: "global", sourceId: "global-source" },
    });
    const overlay = candidateFromDocument(assetDocument("overlay", "skill"), override("overlay", "overlay-group"), {
      revision: "project-revision",
      source: { layer: "project", sourceId: "project-source" },
    });
    const result = resultValue([base, overlay]);

    expect(result.outcome).toBe("conflicted");
    expect(reason(result, "overlay")).toMatchObject({ kind: "excluded", cause: "resolution_conflict" });
    expect(result.conflicts).toEqual([{ kind: "asset_type_conflict", involvedAssetIds: ["overlay"] }]);
  });

  it("rejects a cross-type same-ID disable overlay", () => {
    const base = candidateFromDocument(assetDocument("overlay", "rule"), add(), {
      revision: "global-revision",
      source: { layer: "global", sourceId: "global-source" },
    });
    const overlay = candidateFromDocument(assetDocument("overlay", "skill"), disable("overlay"), {
      revision: "project-revision",
      source: { layer: "project", sourceId: "project-source" },
    });
    const result = resultValue([base, overlay]);

    expect(result.outcome).toBe("conflicted");
    expect(reason(result, "overlay")).toMatchObject({ kind: "excluded", cause: "resolution_conflict" });
    expect(result.conflicts).toEqual([{ kind: "asset_type_conflict", involvedAssetIds: ["overlay"] }]);
  });

  it("rejects a cross-type disable the issuer also requires", () => {
    const target = candidateFromDocument(assetDocument("skill-target", "skill"), add());
    const issuer = candidateFromDocument(
      assetDocument("rule-issuer", "rule", "requires: [skill-target]\n"),
      disable("skill-target"),
    );
    const result = resultValue([issuer, target]);

    expect(result.outcome).toBe("conflicted");
    expect(reason(result, "rule-issuer")).toMatchObject({ kind: "excluded", cause: "resolution_conflict" });
    expect(reason(result, "skill-target")).toMatchObject({ kind: "included" });
    expect(result.conflicts).toEqual([{ kind: "asset_type_conflict", involvedAssetIds: ["rule-issuer", "skill-target"] }]);
  });

  it("rejects a cross-type override the issuer also requires", () => {
    const target = candidateFromDocument(assetDocument("skill-target", "skill"), add("shared-group"));
    const issuer = candidateFromDocument(
      assetDocument("rule-issuer", "rule", "requires: [skill-target]\n"),
      override("skill-target", "shared-group"),
    );
    const result = resultValue([issuer, target]);

    expect(result.outcome).toBe("conflicted");
    expect(reason(result, "rule-issuer")).toMatchObject({ kind: "excluded", cause: "resolution_conflict" });
    expect(reason(result, "skill-target")).toMatchObject({ kind: "included" });
    expect(result.conflicts).toEqual([{ kind: "asset_type_conflict", involvedAssetIds: ["rule-issuer", "skill-target"] }]);
  });

  it("rejects a cross-type disable of a candidate that lost an exclusive merge", () => {
    const winner = candidateFromDocument(assetDocument("rule-winner", "rule"), {
      mandatory: true,
      operation: { kind: "add" },
      mergeMode: "exclusive",
      mergeGroup: "merge-group",
    });
    const loser = candidateFromDocument(assetDocument("rule-loser", "rule"), exclusive("merge-group"));
    const issuer = candidateFromDocument(assetDocument("skill-issuer", "skill"), disable("rule-loser"));
    const result = resultValue([issuer, winner, loser]);

    expect(result.outcome).toBe("conflicted");
    expect(reason(result, "skill-issuer")).toMatchObject({ kind: "excluded", cause: "resolution_conflict" });
    expect(reason(result, "rule-loser")).toMatchObject({ kind: "overridden", overriddenBy: "rule-winner" });
    expect(result.conflicts).toEqual([{ kind: "asset_type_conflict", involvedAssetIds: ["rule-loser", "skill-issuer"] }]);
  });

  it("rejects an exclusive group spanning different asset types", () => {
    const rule = candidateFromDocument(assetDocument("rule-candidate", "rule"), exclusive("cross-type"));
    const skill = candidateFromDocument(assetDocument("skill-candidate", "skill"), exclusive("cross-type"));
    const result = resultValue([rule, skill]);

    expect(result.outcome).toBe("conflicted");
    expect(reason(result, "rule-candidate")).toMatchObject({ kind: "excluded", cause: "resolution_conflict" });
    expect(reason(result, "skill-candidate")).toMatchObject({ kind: "excluded", cause: "resolution_conflict" });
    expect(result.conflicts).toEqual([{ kind: "asset_type_conflict", involvedAssetIds: ["rule-candidate", "skill-candidate"] }]);
  });

  it.each(["role", "task-type", "policy", "guardrail"] as const)("rejects exclusive merge for additive-only type %s", (assetType) => {
    const candidate = candidateFromDocument(assetDocument(`exclusive-${assetType}`, assetType), exclusive("additive-only"));
    const result = resolve([candidate]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("invalid_request");
      const detail = result.failure.details?.find((item) => item.path.at(-1) === "mergeMode");
      expect(detail?.path.slice(-2)).toEqual(["rule", "mergeMode"]);
      expect(detail?.code).toBe("merge_mode_not_allowed");
    }
  });

  it("resolves one candidate for every asset type through the default registry", () => {
    const assetTypes: readonly AssetType[] = ["rule", "knowledge", "skill", "workflow", "role", "task-type", "policy", "guardrail"];
    const candidates = assetTypes.map((assetType) => candidateFromDocument(assetDocument(`asset-${assetType}`, assetType), add()));
    const result = resultValue(candidates);

    expect(result.outcome).toBe("resolved");
    expect(result.conflicts).toEqual([]);
    expect(result.evaluations).toHaveLength(assetTypes.length);
    expect(result.evaluations.every((item) => item.reason.kind === "included")).toBe(true);
  });

  it("applies an injected registry that removes override from rule", () => {
    const contracts: AssetTypeContractRegistry = {
      ...DEFAULT_ASSET_TYPE_CONTRACTS,
      rule: {
        ...DEFAULT_ASSET_TYPE_CONTRACTS.rule,
        allowedOperationKinds: ["add", "disable"],
      },
    };
    const candidate = candidateFromDocument(assetDocument("rule-issuer", "rule"), override("missing-target", "injected"));
    const result = resolve([candidate], contracts);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("invalid_request");
      const detail = result.failure.details?.find((item) => item.path.at(-1) === "kind");
      expect(detail?.path.slice(-2)).toEqual(["operation", "kind"]);
      expect(detail?.code).toBe("operation_not_allowed");
    }
  });

  it("derives the execution profile reverse mapping from the default registry", () => {
    const actual: Record<AssetTypeExecutionProfile, AssetType[]> = {
      "instruction-body": [],
      "runtime-callable": [],
      "workflow-definition": [],
      "catalog-definition": [],
      "policy-input": [],
      "guardrail-input": [],
    };
    for (const [assetType, contract] of Object.entries(DEFAULT_ASSET_TYPE_CONTRACTS)) {
      actual[contract.executionProfile].push(assetType as AssetType);
    }

    expect(actual).toEqual({
      "instruction-body": ["rule", "knowledge"],
      "runtime-callable": ["skill"],
      "workflow-definition": ["workflow"],
      "catalog-definition": ["role", "task-type"],
      "policy-input": ["policy"],
      "guardrail-input": ["guardrail"],
    });
  });

  it("allows capability dependencies only for skills in the default registry", () => {
    expect(Object.fromEntries(
      Object.entries(DEFAULT_ASSET_TYPE_CONTRACTS).map(([assetType, contract]) => [assetType, contract.allowsCapabilityDependencies]),
    )).toEqual({
      rule: false,
      knowledge: false,
      skill: true,
      workflow: false,
      role: false,
      "task-type": false,
      policy: false,
      guardrail: false,
    });
  });

  it("rejects capability dependencies for a non-skill candidate", () => {
    const base = candidateFromDocument(assetDocument("rule-with-capability", "rule"), add());
    const candidate = {
      ...base,
      rule: {
        ...base.rule,
        capabilityDependencies: [{ strength: "required" as const, capability: { capabilityId: "capability" as CapabilityId } }],
      },
    };
    const result = resolve([candidate]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("invalid_request");
      expect(result.failure.details?.some((item) => item.code === "capability_dependencies_not_allowed")).toBe(true);
    }
  });

  it("keeps asset type branching out of the shared resolver source", () => {
    // Scoped to `src/resolution`, not to `src/**`: an asset type comparison is
    // legitimate elsewhere in the domain — `workflow.ts` rejects a definition
    // whose type is not `workflow`, and the catalog projects role and task-type
    // by name. Only the shared resolution pipeline owes type-blindness, and it is
    // spread across every module in that directory, so the whole directory is read.
    const sourceFiles = import.meta.glob<string>("../src/resolution/*.ts", {
      eager: true,
      import: "default",
      query: "?raw",
    });
    const entries = Object.entries(sourceFiles);
    if (entries.length === 0) throw new Error("No resolution source file was found");

    for (const [path, source] of entries) {
      expect(source, `${path}: this prohibition also applies to comment text; use wording that avoids the forbidden patterns.`).not.toMatch(/assetType\s*[!=]==?\s*"/);
      expect(source, `${path}: this prohibition also applies to comment text; use wording that avoids the forbidden patterns.`).not.toMatch(/switch\s*\([^)]*assetType/);
    }
  });
});
