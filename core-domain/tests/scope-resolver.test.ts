import { describe, expect, it } from "vitest";
import {
  parseResolveRequest,
  parseResolvedContextDto,
  tryParseResolvedContextDto,
} from "@aacl/shared";
import type { AssetId, AssetRevision, AssetType, LoadingTier, ResolutionScopeInput } from "@aacl/shared";
import {
  parseAssetDocument,
  resolveScope,
  toResolutionConflictDetails,
  toResolutionConflictDto,
  toResolutionReasonDto,
  validateAsset,
} from "../src/index.ts";
import { buildCapabilityCatalog } from "../src/capabilities.ts";
import type { CapabilityDependency, CapabilityFeatureId, CapabilityId, CapabilityOffer, CapabilityResolutionContext } from "../src/capabilities.ts";
import type {
  AssetCandidate,
  CandidateReason,
  CanonicalAsset,
  ResolutionAxis,
  ResolutionEvaluation,
  ResolutionMerge,
  ResolutionOperation,
  ResolutionResult,
  ResolutionRule,
  ResolutionSource,
} from "../src/index.ts";

type ResolutionDirectives = {
  readonly mandatory: boolean;
  readonly explicitPriority?: number;
  readonly operation: ResolutionOperation;
  readonly mergeMode: ResolutionMerge["mergeMode"];
  readonly mergeGroup?: string;
  readonly capabilityDependencies?: readonly CapabilityDependency[];
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

const capabilityId = (value: string): CapabilityId => value as CapabilityId;
const capabilityFeatureId = (value: string): CapabilityFeatureId => value as CapabilityFeatureId;

const capabilityReference = (value: string, features?: readonly string[]) => ({
  capabilityId: capabilityId(value),
  ...(features === undefined ? {} : { features: features.map(capabilityFeatureId) }),
});

const capabilityOffer = (value: string, features: readonly string[] = []): CapabilityOffer => ({
  capabilityId: capabilityId(value),
  features: features.map(capabilityFeatureId),
});

const capabilityContext = (
  definitions: readonly { readonly id: string; readonly features?: readonly string[] }[],
  offers: readonly CapabilityOffer[],
): CapabilityResolutionContext => ({
  catalog: expectOk(buildCapabilityCatalog(definitions.map(({ id, features }) => ({
    capabilityId: capabilityId(id),
    displayName: id,
    features: (features ?? []).map(capabilityFeatureId),
  })))),
  offers,
});

const assetDocument = (id: string, fields = "", type: AssetType = "rule"): string => `---
id: ${id}
type: ${type}
tier: core
${fields}---
`;

const candidateFromCanonicalAsset = (
  asset: CanonicalAsset,
  directives: ResolutionDirectives,
  fixture: FixtureMetadata = {},
): AssetCandidate => {
  const selectors: Partial<Record<ResolutionAxis, readonly string[]>> = {};
  if (asset.scope.project !== undefined) selectors.projectId = asset.scope.project;
  if (asset.scope.workflow !== undefined) selectors.workflowId = asset.scope.workflow;
  if (asset.scope.stage !== undefined) selectors.stageId = asset.scope.stage;
  if (asset.scope["task-type"] !== undefined) selectors.taskTypeId = asset.scope["task-type"];
  if (asset.scope.role !== undefined) selectors.roleId = asset.scope.role;
  if (asset.scope.provider !== undefined) selectors.providerId = asset.scope.provider;
  if (asset.scope.runtime !== undefined) selectors.runtimeId = asset.scope.runtime;
  if (asset.scope.model !== undefined) selectors.modelId = asset.scope.model;
  if (asset.scope.directory !== undefined) selectors.directory = asset.scope.directory;

  const merge = directives.mergeMode === "exclusive"
    ? { mergeMode: "exclusive" as const, mergeGroup: directives.mergeGroup as string }
    : directives.mergeGroup === undefined
      ? { mergeMode: "additive" as const }
      : { mergeMode: "additive" as const, mergeGroup: directives.mergeGroup };

  return {
    assetId: asset.id,
    revision: (fixture.revision ?? `revision-${asset.id}`) as AssetRevision,
    assetType: asset.type,
    loadingTier: asset.tier,
    source: fixture.source ?? { layer: "global", sourceId: `source-${asset.id}` },
    rule: {
      selectors,
      mandatory: directives.mandatory,
      operation: directives.operation,
      ...(directives.explicitPriority === undefined ? {} : { explicitPriority: directives.explicitPriority }),
      requires: asset.requires,
      ...(directives.capabilityDependencies === undefined ? {} : { capabilityDependencies: directives.capabilityDependencies }),
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

const resolve = (
  scope: ResolutionScopeInput,
  candidates: readonly AssetCandidate[],
  capabilityContextValue?: CapabilityResolutionContext,
) => resolveScope({
  scope: parseResolveRequest({ scope }).scope,
  snapshot: { candidates },
  ...(capabilityContextValue === undefined ? {} : { capabilityContext: capabilityContextValue }),
});

const resultValue = (
  scope: ResolutionScopeInput,
  candidates: readonly AssetCandidate[],
  capabilityContextValue?: CapabilityResolutionContext,
): ResolutionResult => expectOk(resolve(scope, candidates, capabilityContextValue));

const evaluation = (result: ResolutionResult, assetId: string): ResolutionEvaluation => {
  const found = result.evaluations.find((item) => item.candidate.assetId === assetId);
  if (found === undefined) throw new Error(`Evaluation for ${assetId} was not found.`);
  return found;
};

const reason = (result: ResolutionResult, assetId: string): CandidateReason => evaluation(result, assetId).reason;

const withDirectorySelectors = (candidate: AssetCandidate, directory: readonly string[]): AssetCandidate => ({
  ...candidate,
  rule: { ...candidate.rule, selectors: { ...candidate.rule.selectors, directory } },
});

const permutations = <Value>(values: readonly Value[]): readonly (readonly Value[])[] => {
  if (values.length <= 1) return [values];
  const result: Value[][] = [];
  values.forEach((value, index) => {
    const rest = [...values.slice(0, index), ...values.slice(index + 1)];
    for (const tail of permutations(rest)) result.push([value, ...tail]);
  });
  return result;
};

const add = (): ResolutionDirectives => ({
  mandatory: false,
  operation: { kind: "add" },
  mergeMode: "additive",
});

const exclusive = (
  mergeGroup: string,
  overrides: { readonly explicitPriority?: number; readonly mandatory?: boolean } = {},
): ResolutionDirectives => ({
  mandatory: overrides.mandatory ?? false,
  operation: { kind: "add" },
  mergeMode: "exclusive",
  mergeGroup,
  ...(overrides.explicitPriority === undefined ? {} : { explicitPriority: overrides.explicitPriority }),
});

describe("scope resolver", () => {
  it("case 0: resolves an empty snapshot without implicit candidates or conflicts", () => {
    const result = resultValue({}, []);

    expect(result.evaluations).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
    expect(result.outcome).toBe("resolved");
  });

  it("case 0-c: returns invalid_request for a structurally invalid candidate", () => {
    const result = resolve({}, [null as unknown as AssetCandidate]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("invalid_request");
      expect(result.failure.details?.[0]?.code).toBe("invalid_value");
    }
  });

  it("case 0-d: validates structure before excluding an invalid-directory candidate", () => {
    const malformed = { rule: { selectors: { directory: "bad" } } } as unknown as AssetCandidate;
    const result = resolve({}, [malformed]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("invalid_request");
      expect(result.failure.details?.some((item) => item.path.includes("assetId"))).toBe(true);
    }
  });

  it.each(["assetType", "loadingTier"] as const)("case 0-e: rejects an unknown %s", (field) => {
    const valid = candidateFromDocument(assetDocument("asset-invalid-enum"), add());
    const invalid = field === "assetType"
      ? { ...valid, assetType: "bogus" }
      : { ...valid, loadingTier: "bogus" };
    const result = resolve({}, [invalid as unknown as AssetCandidate]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("invalid_request");
      expect(result.failure.details?.some((item) => item.path.includes(field) && item.code === "invalid_value")).toBe(true);
    }
  });

  it("case 0-b: keeps different global meanings conflicted when every axis is unknown", () => {
    const assetRole = candidateFromDocument(
      assetDocument("asset-role", "scope.role: [reviewer]\n"),
      exclusive("global"),
    );
    const assetProject = candidateFromDocument(
      assetDocument("asset-project", "scope.project: [acme]\n"),
      exclusive("global"),
    );
    const result = resultValue({}, [assetRole, assetProject]);

    expect(result.outcome).toBe("conflicted");
    expect(result.conflicts).toEqual([{
      kind: "exclusive_tie",
      mergeGroup: "global",
      involvedAssetIds: ["asset-project", "asset-role"],
    }]);
    for (const assetId of ["asset-project", "asset-role"]) {
      const current = evaluation(result, assetId);
      expect(current.reason).toMatchObject({
        kind: "excluded",
        cause: "resolution_conflict",
        rank: { sourcePrecedence: 0, explicitPriority: -1, matchingAxisCount: 0, directoryDepth: 0 },
      });
    }
  });

  it("pins all nine asset-scope to resolution-scope axis mappings", () => {
    const candidate = candidateFromDocument(
      assetDocument("asset-all-axes", `scope.project: [acme]
scope.workflow: [review-flow]
scope.stage: [review]
scope.task-type: [implementation]
scope.role: [reviewer]
scope.provider: [anthropic]
scope.runtime: [claude-code]
scope.model: [model-a]
scope.directory: [/repo/src]
requires: [asset-required, asset-prerequisite]
`),
      add(),
    );
    expect(candidate.rule.selectors).toEqual({
      projectId: ["acme"],
      workflowId: ["review-flow"],
      stageId: ["review"],
      taskTypeId: ["implementation"],
      roleId: ["reviewer"],
      providerId: ["anthropic"],
      runtimeId: ["claude-code"],
      modelId: ["model-a"],
      directory: ["/repo/src"],
    });

    const result = resultValue({
      projectId: "acme",
      workflowId: "review-flow",
      stageId: "review",
      taskTypeId: "implementation",
      roleId: "reviewer",
      providerId: "anthropic",
      runtimeId: "claude-code",
      modelId: "model-a",
      directory: "/repo/src/unit",
    }, [
      candidate,
      candidateFromDocument(assetDocument("asset-prerequisite"), add()),
      candidateFromDocument(assetDocument("asset-required"), add()),
    ]);
    expect(reason(result, "asset-all-axes")).toEqual({
      kind: "included",
      matchedAxes: ["projectId", "workflowId", "stageId", "taskTypeId", "roleId", "providerId", "runtimeId", "modelId", "directory"],
      rank: { sourcePrecedence: 0, explicitPriority: -1, matchingAxisCount: 8, directoryDepth: 2 },
    });
    expect(candidate.rule.requires).toEqual(["asset-prerequisite", "asset-required"]);
    expect(result.scope.directory).toBe("/repo/src/unit");
  });

  it("case 1: includes a global candidate without selectors", () => {
    const result = resultValue({ roleId: "reviewer" }, [candidateFromDocument(assetDocument("asset-a"), add())]);

    expect(result.outcome).toBe("resolved");
    expect(result.conflicts).toHaveLength(0);
    expect(reason(result, "asset-a")).toEqual({
      kind: "included",
      matchedAxes: [],
      rank: { sourcePrecedence: 0, explicitPriority: -1, matchingAxisCount: 0, directoryDepth: 0 },
    });
  });

  it("case 2: matches any selected role and excludes an outsider", () => {
    const candidate = candidateFromDocument(assetDocument("asset-a", "scope.role: [author, reviewer]\n"), add());
    for (const [scope, expected] of [
      [{ roleId: "reviewer" }, "included"],
      [{ roleId: "author" }, "included"],
      [{ roleId: "outsider" }, "excluded"],
    ] as const) {
      const result = resultValue(scope, [candidate]);
      expect(reason(result, "asset-a").kind).toBe(expected);
      if (expected === "included") expect(reason(result, "asset-a")).toMatchObject({ matchedAxes: ["roleId"] });
      else expect(reason(result, "asset-a")).toEqual({ kind: "excluded", cause: "scope_mismatch", mismatchedAxes: ["roleId"] });
      expect(result.outcome).toBe("resolved");
      expect(result.conflicts).toHaveLength(0);
    }
  });

  it("case 3: reports only the mismatched axis and treats an unknown selector axis as neutral", () => {
    const candidate = candidateFromDocument(assetDocument("asset-a", `scope.role: [reviewer]
scope.project: [acme]
`), add());
    expect(reason(resultValue({ roleId: "reviewer", projectId: "other" }, [candidate]), "asset-a")).toEqual({
      kind: "excluded", cause: "scope_mismatch", mismatchedAxes: ["projectId"],
    });
    expect(reason(resultValue({ roleId: "author", projectId: "acme" }, [candidate]), "asset-a")).toEqual({
      kind: "excluded", cause: "scope_mismatch", mismatchedAxes: ["roleId"],
    });
    const included = resultValue({ roleId: "reviewer" }, [candidate]);
    expect(included.outcome).toBe("resolved");
    expect(reason(included, "asset-a").kind).toBe("included");
  });

  it("case 4: does not let an unspecified model affect matching or specificity", () => {
    const candidate = candidateFromDocument(assetDocument("asset-a", "scope.model: [model-a]\n"), add());
    const result = resultValue({ roleId: "reviewer" }, [candidate]);

    expect(reason(result, "asset-a")).toEqual({
      kind: "included",
      matchedAxes: [],
      rank: { sourcePrecedence: 0, explicitPriority: -1, matchingAxisCount: 0, directoryDepth: 0 },
    });
    expect(result.outcome).toBe("resolved");
  });

  it("case 5: normalizes directory scope and matches descendants but not sibling prefixes", () => {
    const candidate = candidateFromDocument(assetDocument("asset-src", "scope.directory: [/repo/src]\n"), add());
    for (const directory of ["/repo/src", "/repo/src/", "/repo/src/file.ts"] as const) {
      const result = resultValue({ directory }, [candidate]);
      expect(result.scope.directory).toBe(directory === "/repo/src/" ? "/repo/src" : directory);
      expect(result.outcome).toBe("resolved");
      expect(reason(result, "asset-src")).toMatchObject({ kind: "included", rank: { directoryDepth: 2 } });
    }
    const excluded = resultValue({ directory: "/repo/src-extra" }, [candidate]);
    expect(excluded.outcome).toBe("resolved");
    expect(reason(excluded, "asset-src").kind).toBe("excluded");
  });

  it("case 5-b: gives root and unscoped candidates the same rank but different meaning", () => {
    const root = candidateFromDocument(assetDocument("asset-root", "scope.directory: [/]\n"), exclusive("g"));
    const unscoped = candidateFromDocument(assetDocument("asset-unscoped"), exclusive("g"));
    const result = resultValue({ directory: "/repo/src" }, [root, unscoped]);

    expect(result.outcome).toBe("conflicted");
    expect(result.conflicts[0]).toEqual({ kind: "exclusive_tie", mergeGroup: "g", involvedAssetIds: ["asset-root", "asset-unscoped"] });
    expect(reason(result, "asset-root")).toMatchObject({ rank: { directoryDepth: 0, matchingAxisCount: 0 } });
    expect(reason(result, "asset-unscoped")).toMatchObject({ rank: { directoryDepth: 0, matchingAxisCount: 0 } });
  });

  it("case 6: chooses the deepest matching directory in an exclusive group", () => {
    const candidates = [
      candidateFromDocument(assetDocument("asset-repo", "scope.directory: [/repo]\n"), exclusive("g")),
      candidateFromDocument(assetDocument("asset-src", "scope.directory: [/repo/src]\n"), exclusive("g")),
      candidateFromDocument(assetDocument("asset-tests", "scope.directory: [/repo/src/tests]\n"), exclusive("g")),
    ];
    const result = resultValue({ directory: "/repo/src/tests/unit" }, candidates);

    expect(reason(result, "asset-tests")).toMatchObject({ kind: "included", rank: { directoryDepth: 3 } });
    expect(reason(result, "asset-src")).toMatchObject({ kind: "overridden", overriddenBy: "asset-tests", mergeGroup: "g", winnerRank: { directoryDepth: 3 } });
    expect(reason(result, "asset-repo")).toMatchObject({ kind: "overridden", overriddenBy: "asset-tests", mergeGroup: "g", winnerRank: { directoryDepth: 3 } });
    expect(result.outcome).toBe("resolved");
    expect(result.conflicts).toHaveLength(0);
  });

  it("case 20: matches a project source by its project selector", () => {
    const candidate = candidateFromDocument(assetDocument("asset-project", "scope.project: [project-a]\n"), add(), { source: { layer: "project", sourceId: "project-source" } });
    const included = resultValue({ projectId: "project-a" }, [candidate]);
    expect(included.outcome).toBe("resolved");
    const includedReason = reason(included, "asset-project");
    expect(includedReason.kind).toBe("included");
    if (includedReason.kind === "included") expect(includedReason.rank).toMatchObject({ sourcePrecedence: 2 });
    const excluded = resultValue({ projectId: "project-b" }, [candidate]);
    expect(excluded.outcome).toBe("resolved");
    expect(reason(excluded, "asset-project")).toEqual({ kind: "excluded", cause: "scope_mismatch", mismatchedAxes: ["projectId"] });
  });

  it("case 7: compares explicit priority before matching specificity", () => {
    const priority = candidateFromDocument(assetDocument("asset-priority", "scope.role: [reviewer]\n"), exclusive("g", { explicitPriority: 10 }));
    const specific = candidateFromDocument(assetDocument("asset-specific", `scope.role: [reviewer]
scope.project: [acme]
`), exclusive("g", { explicitPriority: 9 }));
    const result = resultValue({ roleId: "reviewer", projectId: "acme" }, [priority, specific]);

    expect(reason(result, "asset-priority").kind).toBe("included");
    expect(reason(result, "asset-specific")).toMatchObject({ kind: "overridden", overriddenBy: "asset-priority", mergeGroup: "g" });
    expect(result.outcome).toBe("resolved");
  });

  it("case 8: preserves a mandatory target and reports a mandatory disable conflict", () => {
    const base = candidateFromDocument(assetDocument("asset-base"), { ...add(), mandatory: true });
    const disable = candidateFromDocument(assetDocument("asset-disable", "scope.project: [acme]\n"), {
      ...add(), operation: { kind: "disable", targetAssetId: "asset-base" as AssetId },
    });
    const result = resultValue({ projectId: "acme" }, [base, disable]);

    expect(result.outcome).toBe("conflicted");
    expect(result.conflicts).toEqual([{ kind: "mandatory_conflict", involvedAssetIds: ["asset-base", "asset-disable"] }]);
    expect(evaluation(result, "asset-base")).toBeDefined();
    expect(evaluation(result, "asset-disable")).toBeDefined();
  });

  it("case 9: applies an explicit override only to its target in the same merge group", () => {
    const base = candidateFromDocument(assetDocument("asset-base"), exclusive("g"));
    const override = candidateFromDocument(assetDocument("asset-override"), {
      ...exclusive("g"), operation: { kind: "override", targetAssetId: "asset-base" as AssetId },
    }, { source: { layer: "personal", sourceId: "personal-source" } });
    const result = resultValue({}, [base, override]);

    expect(result.outcome).toBe("resolved");
    expect(reason(result, "asset-override").kind).toBe("included");
    expect(reason(result, "asset-base")).toMatchObject({ kind: "overridden", overriddenBy: "asset-override", mergeGroup: "g" });
  });

  it.each(["override", "disable"] as const)("case 9-b: accepts a same-ID %s overlay from a higher source layer", (operationKind) => {
    const base = candidateFromDocument(assetDocument("asset-base"), operationKind === "override" ? { ...add(), mergeGroup: "g" } : add(), {
      source: { layer: "global", sourceId: "global-source" },
    });
    const overlay = candidateFromDocument(assetDocument("asset-base"), {
      ...(operationKind === "override" ? { ...add(), mergeGroup: "g" } : add()),
      operation: { kind: operationKind, targetAssetId: "asset-base" as AssetId },
    }, { source: { layer: "project", sourceId: "project-source" } });
    const result = resultValue({}, [base, overlay]);
    const baseEvaluation = result.evaluations.find((item) => item.candidate.source.layer === "global");
    const overlayEvaluation = result.evaluations.find((item) => item.candidate.source.layer === "project");

    expect(result.outcome).toBe("resolved");
    expect(result.conflicts).toHaveLength(0);
    expect(baseEvaluation?.reason.kind).toBe(operationKind === "override" ? "overridden" : "disabled");
    expect(overlayEvaluation?.reason.kind).toBe("included");
  });

  it("case 9-c: keeps an unrelated same-ID candidate in duplicate conflict", () => {
    const base = candidateFromDocument(assetDocument("asset-base"), add(), {
      source: { layer: "global", sourceId: "global-source" },
    });
    const overlay = candidateFromDocument(assetDocument("asset-base"), {
      ...add(), operation: { kind: "disable", targetAssetId: "asset-base" as AssetId },
    }, { source: { layer: "personal", sourceId: "personal-source" } });
    const unrelated = candidateFromDocument(assetDocument("asset-base"), add(), {
      source: { layer: "personal", sourceId: "other-personal-source" },
    });
    const result = resultValue({}, [base, overlay, unrelated]);

    expect(result.outcome).toBe("conflicted");
    expect(result.conflicts).toEqual([{ kind: "duplicate_identity", assetId: "asset-base", involvedAssetIds: ["asset-base"] }]);
    expect(result.evaluations.every((item) => item.reason.kind === "excluded")).toBe(true);
  });

  it.each(["override", "disable"] as const)("case 9-d: applies a stacked %s overlay to every lower layer", (operationKind) => {
    const directives = operationKind === "override" ? { ...add(), mergeGroup: "g" } : add();
    const base = candidateFromDocument(assetDocument("asset-stack"), directives, {
      source: { layer: "global", sourceId: "global-source" },
    });
    const personal = candidateFromDocument(assetDocument("asset-stack"), {
      ...directives,
      operation: { kind: operationKind, targetAssetId: "asset-stack" as AssetId },
    }, { source: { layer: "personal", sourceId: "personal-source" } });
    const project = candidateFromDocument(assetDocument("asset-stack"), {
      ...directives,
      operation: { kind: operationKind, targetAssetId: "asset-stack" as AssetId },
    }, { source: { layer: "project", sourceId: "project-source" } });
    const result = resultValue({}, [base, personal, project]);
    const lowerEvaluations = result.evaluations.filter((item) => item.candidate.source.layer !== "project");

    expect(result.outcome).toBe("resolved");
    expect(result.conflicts).toHaveLength(0);
    expect(lowerEvaluations.every((item) => item.reason.kind === (operationKind === "override" ? "overridden" : "disabled"))).toBe(true);
  });

  it("case 10: keeps additive assets and resolves the exclusive subgroup", () => {
    const candidates = [
      candidateFromDocument(assetDocument("asset-add-a"), add()),
      candidateFromDocument(assetDocument("asset-add-b"), add()),
      candidateFromDocument(assetDocument("asset-exclusive-a"), exclusive("g", { explicitPriority: 2 })),
      candidateFromDocument(assetDocument("asset-exclusive-b"), exclusive("g", { explicitPriority: 1 })),
    ];
    const result = resultValue({}, candidates);

    expect(result.evaluations).toHaveLength(4);
    expect(result.evaluations.filter((item) => item.reason.kind === "included").map((item) => item.candidate.assetId)).toEqual(["asset-exclusive-a", "asset-add-a", "asset-add-b"]);
    expect(reason(result, "asset-exclusive-b")).toEqual({ kind: "overridden", overriddenBy: "asset-exclusive-a", mergeGroup: "g", winnerRank: { sourcePrecedence: 0, explicitPriority: 2, matchingAxisCount: 0, directoryDepth: 0 } });
    expect(result.outcome).toBe("resolved");
  });

  it("case 10-b: does not apply an operation from an exclusive loser", () => {
    const target = candidateFromDocument(assetDocument("asset-target"), add());
    const loser = candidateFromDocument(assetDocument("asset-loser"), {
      ...exclusive("g", { explicitPriority: 1 }),
      operation: { kind: "disable", targetAssetId: "asset-target" as AssetId },
    });
    const winner = candidateFromDocument(assetDocument("asset-winner"), exclusive("g", { explicitPriority: 2 }));
    const result = resultValue({}, [target, loser, winner]);

    expect(result.outcome).toBe("resolved");
    expect(result.conflicts).toHaveLength(0);
    expect(reason(result, "asset-target").kind).toBe("included");
    expect(reason(result, "asset-loser")).toMatchObject({ kind: "overridden", overriddenBy: "asset-winner" });
  });

  it.each(["case 11", "case 11-b"]) ("%s: leaves a non-total exclusive rank as a conflict", (caseName) => {
    const fields = caseName === "case 11" ? "" : "scope.role: [reviewer]\n";
    const candidates = [
      candidateFromDocument(assetDocument("asset-a", fields), exclusive("g")),
      candidateFromDocument(assetDocument("asset-b", fields), exclusive("g")),
    ];
    const result = resultValue(caseName === "case 11" ? {} : { roleId: "reviewer" }, candidates);

    expect(result.outcome).toBe("conflicted");
    expect(result.conflicts[0]?.kind).toBe("exclusive_tie");
    expect(reason(result, "asset-a")).toMatchObject({ kind: "excluded", cause: "resolution_conflict" });
    expect(reason(result, "asset-b")).toMatchObject({ kind: "excluded", cause: "resolution_conflict" });
    if (caseName === "case 11-b") {
      expect(reason(result, "asset-a")).toMatchObject({ rank: { sourcePrecedence: 0, explicitPriority: -1, matchingAxisCount: 1, directoryDepth: 0 } });
      expect(reason(result, "asset-b")).toMatchObject({ rank: { sourcePrecedence: 0, explicitPriority: -1, matchingAxisCount: 1, directoryDepth: 0 } });
    }
  });

  it("case 11: projects a tie conflict and its per-asset details", () => {
    const result = resultValue({}, [
      candidateFromDocument(assetDocument("asset-a"), exclusive("g")),
      candidateFromDocument(assetDocument("asset-b"), exclusive("g")),
    ]);
    const conflict = result.conflicts[0];
    if (conflict === undefined) throw new Error("Expected a conflict.");

    const conflictDto = toResolutionConflictDto(conflict);
    expect(conflictDto.involvedAssetIds).toEqual(["asset-a", "asset-b"]);
    expect(conflictDto.explanation).not.toBe("");
    const details = toResolutionConflictDetails(conflict);
    expect(details).toEqual([
      { path: ["resolution", "conflict", "exclusive_tie", "asset-a"], code: "exclusive_tie", message: expect.any(String) },
      { path: ["resolution", "conflict", "exclusive_tie", "asset-b"], code: "exclusive_tie", message: expect.any(String) },
    ]);
    expect(details.every((item) => item.message.length > 0)).toBe(true);
  });

  it("case 12: exposes public reasons for mismatch, disable, override, and unavailable states", () => {
    const result = resultValue({ roleId: "reviewer" }, [
      candidateFromDocument(assetDocument("asset-mismatch", "scope.role: [author]\n"), add()),
      candidateFromDocument(assetDocument("asset-target"), add()),
      candidateFromDocument(assetDocument("asset-disable", "scope.role: [reviewer]\n"), { ...add(), operation: { kind: "disable", targetAssetId: "asset-target" as AssetId } }),
      candidateFromDocument(assetDocument("asset-loser"), exclusive("g", { explicitPriority: 1 })),
      candidateFromDocument(assetDocument("asset-winner"), exclusive("g", { explicitPriority: 2 })),
      candidateFromDocument(assetDocument("asset-missing", "requires: [missing-asset]\n"), add()),
    ]);

    expect(toResolutionReasonDto(reason(result, "asset-mismatch"))).toMatchObject({ kind: "excluded" });
    expect(toResolutionReasonDto(reason(result, "asset-target"))).toMatchObject({ kind: "disabled", disabledBy: "asset-disable" });
    expect(toResolutionReasonDto(reason(result, "asset-loser"))).toMatchObject({ kind: "overridden", overriddenBy: "asset-winner" });
    expect(toResolutionReasonDto(reason(result, "asset-missing"))).toMatchObject({ kind: "unavailable", availability: "unavailable" });
    for (const assetId of ["asset-mismatch", "asset-disable", "asset-loser", "asset-missing"]) {
      expect(toResolutionReasonDto(reason(result, assetId)).explanation).not.toBe("");
    }
    expect(result.outcome).toBe("resolved");
  });

  it("case 13: makes conflict and evaluation order independent of candidate order", () => {
    const resolveOrdered = (ids: readonly ["asset-a" | "asset-b", "asset-a" | "asset-b"]) => resultValue({}, ids.map((id) => candidateFromDocument(assetDocument(id), exclusive("g"))));
    const left = resolveOrdered(["asset-b", "asset-a"]);
    const right = resolveOrdered(["asset-a", "asset-b"]);

    expect(left.outcome).toBe("conflicted");
    expect(right.outcome).toBe("conflicted");
    expect(left.conflicts).toEqual(right.conflicts);
    expect(left.evaluations.map((item) => item.candidate.assetId)).toEqual(["asset-a", "asset-b"]);
    expect(right.evaluations.map((item) => item.candidate.assetId)).toEqual(["asset-a", "asset-b"]);
    expect(toResolutionConflictDetails(left.conflicts[0]!)).toEqual(toResolutionConflictDetails(right.conflicts[0]!));
  });

  it("case 14-a: marks a missing requirement unavailable without a resolver conflict", () => {
    const result = resultValue({}, [candidateFromDocument(assetDocument("asset-dependent", "requires: [asset-missing]\n"), add())]);

    expect(result.outcome).toBe("resolved");
    expect(reason(result, "asset-dependent")).toEqual({ kind: "unavailable", availability: "unavailable", cause: "missing_requirement", failedRequirements: ["asset-missing"] });
  });

  it("case 14-b: detects a self requirement cycle after parsing", () => {
    const result = resultValue({}, [candidateFromDocument(assetDocument("asset-self", "requires: [asset-self]\n"), add())]);

    expect(result.outcome).toBe("resolved");
    expect(reason(result, "asset-self")).toEqual({ kind: "unavailable", availability: "unavailable", cause: "requirement_cycle", failedRequirements: ["asset-self"] });
  });

  it("case 14-c: detects a two-asset requirement cycle", () => {
    const result = resultValue({}, [
      candidateFromDocument(assetDocument("asset-a", "requires: [asset-b]\n"), add()),
      candidateFromDocument(assetDocument("asset-b", "requires: [asset-a]\n"), add()),
    ]);

    expect(result.outcome).toBe("resolved");
    expect(reason(result, "asset-a")).toEqual({ kind: "unavailable", availability: "unavailable", cause: "requirement_cycle", failedRequirements: ["asset-b"] });
    expect(reason(result, "asset-b")).toEqual({ kind: "unavailable", availability: "unavailable", cause: "requirement_cycle", failedRequirements: ["asset-a"] });
  });

  it("case 14-d: reports different meanings for the same source identity as a conflict", () => {
    const source = { layer: "global" as const, sourceId: "source-z" };
    const result = resultValue({}, [
      candidateFromDocument(assetDocument("asset-a"), add(), { revision: "r1", source }),
      candidateFromDocument(assetDocument("asset-a"), add(), { revision: "r2", source }),
    ]);

    expect(result.outcome).toBe("conflicted");
    expect(result.conflicts[0]).toMatchObject({ kind: "duplicate_identity", assetId: "asset-a" });
    expect(result.evaluations).toHaveLength(2);
  });

  it("case 14-e: orders same-identity candidates by their remaining meaning", () => {
    const source = { layer: "global" as const, sourceId: "source-z" };
    const requiresA = candidateFromDocument(assetDocument("asset-a", "requires: [asset-required-a]\n"), add(), { revision: "r1", source });
    const requiresZ = candidateFromDocument(assetDocument("asset-a", "requires: [asset-required-z]\n"), add(), { revision: "r1", source });
    const resolveOrdered = (candidates: readonly AssetCandidate[]) => resultValue({}, candidates);
    const left = resolveOrdered([requiresZ, requiresA]);
    const right = resolveOrdered([requiresA, requiresZ]);

    expect(left.outcome).toBe("conflicted");
    expect(left.conflicts).toEqual(right.conflicts);
    expect(left.evaluations.map((item) => item.candidate.rule.requires)).toEqual([
      ["asset-required-a"],
      ["asset-required-z"],
    ]);
    expect(right.evaluations.map((item) => item.candidate.rule.requires)).toEqual(left.evaluations.map((item) => item.candidate.rule.requires));
  });

  it("case 14-f: re-evaluates dependents after a same-ID overlay resolves", () => {
    const dependent = candidateFromDocument(assetDocument("asset-dependent", "requires: [asset-base]\n"), add());
    const base = candidateFromDocument(assetDocument("asset-base"), { ...add(), mergeGroup: "g" }, {
      source: { layer: "global", sourceId: "global-source" },
    });
    const overlay = candidateFromDocument(assetDocument("asset-base"), {
      ...add(),
      mergeGroup: "g",
      operation: { kind: "override", targetAssetId: "asset-base" as AssetId },
    }, { source: { layer: "project", sourceId: "project-source" } });
    const result = resultValue({}, [dependent, base, overlay]);

    expect(result.outcome).toBe("resolved");
    expect(result.conflicts).toHaveLength(0);
    expect(reason(result, "asset-dependent").kind).toBe("included");
    expect(result.evaluations.find((item) => item.candidate.source.layer === "global")?.reason.kind).toBe("overridden");
  });

  it("case 14-g: re-runs operation discovery for a dependent revived by an overlay", () => {
    const base = candidateFromDocument(assetDocument("asset-base"), { ...add(), mergeGroup: "g" }, {
      source: { layer: "global", sourceId: "global-source" },
    });
    const overlay = candidateFromDocument(assetDocument("asset-base"), {
      ...add(),
      mergeGroup: "g",
      operation: { kind: "override", targetAssetId: "asset-base" as AssetId },
    }, { source: { layer: "project", sourceId: "project-source" } });
    const dependent = candidateFromDocument(assetDocument("asset-dependent", "requires: [asset-base]\n"), {
      ...add(), operation: { kind: "disable", targetAssetId: "asset-target" as AssetId },
    });
    const target = candidateFromDocument(assetDocument("asset-target"), add());
    const result = resultValue({}, [dependent, base, target, overlay]);

    expect(result.outcome).toBe("resolved");
    expect(result.conflicts).toHaveLength(0);
    expect(reason(result, "asset-dependent").kind).toBe("included");
    expect(reason(result, "asset-target")).toEqual({ kind: "disabled", disabledBy: "asset-dependent" });
    expect(result.evaluations.find((item) => item.candidate.source.layer === "global" && item.candidate.assetId === "asset-base")?.reason.kind).toBe("overridden");
  });

  it("case 14-h: canonicalizes dependency-cycle diagnostics across candidate order", () => {
    const makeCandidates = () => ({
      a: candidateFromDocument(assetDocument("asset-a", "requires: [asset-b]\n"), { ...add(), mandatory: true }),
      b: candidateFromDocument(assetDocument("asset-b", "requires: [asset-a, asset-c]\n"), add()),
      c: candidateFromDocument(assetDocument("asset-c", "requires: [asset-a]\n"), add()),
    });
    const first = makeCandidates();
    const second = makeCandidates();
    const left = resultValue({}, [first.a, first.b, first.c]);
    const right = resultValue({}, [second.b, second.c, second.a]);

    expect(left.conflicts).toEqual(right.conflicts);
    expect(left.conflicts).toEqual([{ kind: "dependency_cycle", involvedAssetIds: ["asset-a", "asset-b", "asset-c"] }]);
    expect(reason(left, "asset-a")).toEqual({ kind: "unavailable", availability: "unavailable", cause: "requirement_cycle", failedRequirements: ["asset-b"] });
    expect(reason(left, "asset-b")).toEqual({ kind: "unavailable", availability: "unavailable", cause: "requirement_cycle", failedRequirements: ["asset-a", "asset-c"] });
  });

  it("case 15-a: fails a dependency whose target is outside the requested scope", () => {
    const result = resultValue({ roleId: "reviewer" }, [
      candidateFromDocument(assetDocument("asset-dependent", "requires: [asset-target]\n"), add()),
      candidateFromDocument(assetDocument("asset-target", "scope.role: [author]\n"), add()),
    ]);

    expect(reason(result, "asset-target")).toEqual({ kind: "excluded", cause: "scope_mismatch", mismatchedAxes: ["roleId"] });
    expect(reason(result, "asset-dependent")).toEqual({ kind: "unavailable", availability: "unavailable", cause: "requirement_out_of_scope", failedRequirements: ["asset-target"] });
    expect(result.outcome).toBe("resolved");
  });

  it("case 15-b: does not revive a disabled dependency", () => {
    const result = resultValue({}, [
      candidateFromDocument(assetDocument("asset-dependent", "requires: [asset-target]\n"), add()),
      candidateFromDocument(assetDocument("asset-target"), add()),
      candidateFromDocument(assetDocument("asset-disable"), { ...add(), operation: { kind: "disable", targetAssetId: "asset-target" as AssetId } }),
    ]);

    expect(reason(result, "asset-target")).toEqual({ kind: "disabled", disabledBy: "asset-disable" });
    expect(reason(result, "asset-dependent")).toEqual({ kind: "unavailable", availability: "unavailable", cause: "requirement_disabled", failedRequirements: ["asset-target"] });
    expect(result.outcome).toBe("resolved");
  });

  it("case 15-b-1: re-evaluates a surviving issuer after removing an unavailable blocker", () => {
    const target = candidateFromDocument(assetDocument("asset-target"), add());
    const survivingIssuer = candidateFromDocument(assetDocument("asset-survivor"), {
      ...add(), operation: { kind: "disable", targetAssetId: "asset-target" as AssetId },
    });
    const unavailableIssuer = candidateFromDocument(assetDocument("asset-blocker", "requires: [asset-target]\n"), {
      ...add(), operation: { kind: "disable", targetAssetId: "asset-survivor" as AssetId },
    });
    const result = resultValue({}, [unavailableIssuer, target, survivingIssuer]);

    expect(result.outcome).toBe("resolved");
    expect(result.conflicts).toHaveLength(0);
    expect(reason(result, "asset-survivor").kind).toBe("included");
    expect(reason(result, "asset-target")).toEqual({ kind: "disabled", disabledBy: "asset-survivor" });
    expect(reason(result, "asset-blocker")).toEqual({
      kind: "unavailable",
      availability: "unavailable",
      cause: "requirement_disabled",
      failedRequirements: ["asset-target"],
    });
  });

  it("case 15-b-2: does not let an unavailable issuer disable its target", () => {
    const issuer = candidateFromDocument(assetDocument("asset-issuer", "requires: [asset-missing]\n"), {
      ...add(), operation: { kind: "disable", targetAssetId: "asset-target" as AssetId },
    });
    const target = candidateFromDocument(assetDocument("asset-target"), add());
    const result = resultValue({}, [issuer, target]);

    expect(result.outcome).toBe("resolved");
    expect(result.conflicts).toHaveLength(0);
    expect(reason(result, "asset-issuer")).toEqual({ kind: "unavailable", availability: "unavailable", cause: "missing_requirement", failedRequirements: ["asset-missing"] });
    expect(reason(result, "asset-target").kind).toBe("included");
  });

  it("case 15-b-2-a: excludes an unavailable issuer before operation cycle detection", () => {
    const issuerA = candidateFromDocument(assetDocument("asset-a", "requires: [asset-x]\n"), {
      ...add(), operation: { kind: "disable", targetAssetId: "asset-b" as AssetId },
    });
    const issuerB = candidateFromDocument(assetDocument("asset-b"), {
      ...add(), operation: { kind: "disable", targetAssetId: "asset-a" as AssetId },
    });
    const blocker = candidateFromDocument(assetDocument("asset-d"), {
      ...add(), operation: { kind: "disable", targetAssetId: "asset-x" as AssetId },
    });
    const required = candidateFromDocument(assetDocument("asset-x"), add());
    const result = resultValue({}, [issuerA, issuerB, blocker, required]);

    expect(result.conflicts).toHaveLength(0);
    expect(reason(result, "asset-a")).toEqual({ kind: "disabled", disabledBy: "asset-b" });
    expect(reason(result, "asset-b").kind).toBe("included");
    expect(reason(result, "asset-d").kind).toBe("included");
    expect(reason(result, "asset-x")).toEqual({ kind: "disabled", disabledBy: "asset-d" });
  });

  it("case 15-b-3: rolls back an operation when its issuer loses a required target", () => {
    const issuer = candidateFromDocument(assetDocument("asset-issuer", "requires: [asset-target]\n"), {
      ...add(), operation: { kind: "disable", targetAssetId: "asset-target" as AssetId },
    });
    const target = candidateFromDocument(assetDocument("asset-target"), add());
    const result = resultValue({}, [issuer, target]);

    expect(result.outcome).toBe("resolved");
    expect(result.conflicts).toHaveLength(0);
    expect(reason(result, "asset-issuer").kind).toBe("included");
    expect(reason(result, "asset-target").kind).toBe("included");
  });

  it("case 15-b-4: reports a cycle between operation issuers", () => {
    const left = candidateFromDocument(assetDocument("asset-a"), {
      ...add(), operation: { kind: "disable", targetAssetId: "asset-b" as AssetId },
    });
    const right = candidateFromDocument(assetDocument("asset-b"), {
      ...add(), operation: { kind: "disable", targetAssetId: "asset-a" as AssetId },
    });
    const result = resultValue({}, [left, right]);

    expect(result.outcome).toBe("conflicted");
    expect(result.conflicts).toEqual([{ kind: "operation_conflict", targetAssetId: "asset-a", involvedAssetIds: ["asset-a", "asset-b"] }]);
    expect(reason(result, "asset-a")).toMatchObject({ kind: "excluded", cause: "resolution_conflict" });
    expect(reason(result, "asset-b")).toMatchObject({ kind: "excluded", cause: "resolution_conflict" });
  });

  it("case 15-b-7: reports a non-convergent dependency feedback operation", () => {
    const makeCandidates = () => ({
      a: candidateFromDocument(assetDocument("asset-a"), add()),
      b: candidateFromDocument(assetDocument("asset-b"), { ...add(), operation: { kind: "disable", targetAssetId: "asset-a" as AssetId } }),
      c: candidateFromDocument(assetDocument("asset-c"), { ...add(), operation: { kind: "disable", targetAssetId: "asset-b" as AssetId } }),
      d: candidateFromDocument(assetDocument("asset-d", "requires: [asset-a]\n"), { ...add(), operation: { kind: "disable", targetAssetId: "asset-c" as AssetId } }),
    });
    const first = makeCandidates();
    const second = makeCandidates();
    const left = resultValue({}, [first.b, first.c, first.d, first.a]);
    const right = resultValue({}, [second.d, second.c, second.b, second.a]);

    expect(left.evaluations).toEqual(right.evaluations);
    expect(left.conflicts).toEqual(right.conflicts);
    expect(left.conflicts).toEqual([{ kind: "operation_conflict", targetAssetId: "asset-c", involvedAssetIds: ["asset-c", "asset-d"] }]);
    expect(reason(left, "asset-a").kind).toBe("included");
    expect(reason(left, "asset-b")).toEqual({ kind: "disabled", disabledBy: "asset-c" });
    expect(reason(left, "asset-c").kind).toBe("included");
    expect(reason(left, "asset-d")).toMatchObject({ kind: "excluded", cause: "resolution_conflict" });
  });

  it("case 15-b-8: diagnoses dependents from the final operation-cycle state", () => {
    const result = resultValue({}, [
      candidateFromDocument(assetDocument("asset-dependent", "requires: [asset-a]\n"), add()),
      candidateFromDocument(assetDocument("asset-a"), { ...add(), operation: { kind: "disable", targetAssetId: "asset-b" as AssetId } }),
      candidateFromDocument(assetDocument("asset-b"), { ...add(), operation: { kind: "disable", targetAssetId: "asset-a" as AssetId } }),
    ]);

    expect(result.outcome).toBe("conflicted");
    expect(result.conflicts).toEqual([{ kind: "operation_conflict", targetAssetId: "asset-a", involvedAssetIds: ["asset-a", "asset-b"] }]);
    expect(reason(result, "asset-dependent")).toEqual({
      kind: "unavailable",
      availability: "unavailable",
      cause: "requirement_invalid",
      failedRequirements: ["asset-a"],
    });
    expect(reason(result, "asset-a")).toMatchObject({ kind: "excluded", cause: "resolution_conflict" });
    expect(reason(result, "asset-b")).toMatchObject({ kind: "excluded", cause: "resolution_conflict" });
  });

  it("case 15-b-5: keeps an operation chain deterministic while recomputing blocked issuers", () => {
    const makeCandidates = () => ({
      a: candidateFromDocument(assetDocument("asset-a"), add()),
      b: candidateFromDocument(assetDocument("asset-b"), { ...add(), operation: { kind: "disable", targetAssetId: "asset-a" as AssetId } }),
      c: candidateFromDocument(assetDocument("asset-c"), { ...add(), operation: { kind: "disable", targetAssetId: "asset-b" as AssetId } }),
      d: candidateFromDocument(assetDocument("asset-d"), { ...add(), operation: { kind: "disable", targetAssetId: "asset-c" as AssetId } }),
    });
    const first = makeCandidates();
    const second = makeCandidates();
    const left = resultValue({}, [first.b, first.c, first.d, first.a]);
    const right = resultValue({}, [second.d, second.c, second.b, second.a]);

    expect(left.evaluations).toEqual(right.evaluations);
    expect(left.conflicts).toEqual(right.conflicts);
    expect(reason(left, "asset-a")).toEqual({ kind: "disabled", disabledBy: "asset-b" });
    expect(reason(left, "asset-b").kind).toBe("included");
    expect(reason(left, "asset-c")).toEqual({ kind: "disabled", disabledBy: "asset-d" });
  });

  it("case 15-b-6: reports every disjoint operation cycle", () => {
    const makeCandidates = () => ({
      a: candidateFromDocument(assetDocument("asset-a"), { ...add(), operation: { kind: "disable", targetAssetId: "asset-b" as AssetId } }),
      b: candidateFromDocument(assetDocument("asset-b"), { ...add(), operation: { kind: "disable", targetAssetId: "asset-a" as AssetId } }),
      c: candidateFromDocument(assetDocument("asset-c"), { ...add(), operation: { kind: "disable", targetAssetId: "asset-d" as AssetId } }),
      d: candidateFromDocument(assetDocument("asset-d"), { ...add(), operation: { kind: "disable", targetAssetId: "asset-c" as AssetId } }),
    });
    const first = makeCandidates();
    const second = makeCandidates();
    const left = resultValue({}, [first.c, first.d, first.a, first.b]);
    const right = resultValue({}, [second.b, second.a, second.d, second.c]);

    expect(left.conflicts).toEqual(right.conflicts);
    expect(left.conflicts).toEqual([
      { kind: "operation_conflict", targetAssetId: "asset-a", involvedAssetIds: ["asset-a", "asset-b"] },
      { kind: "operation_conflict", targetAssetId: "asset-c", involvedAssetIds: ["asset-c", "asset-d"] },
    ]);
    for (const assetId of ["asset-a", "asset-b", "asset-c", "asset-d"]) {
      expect(reason(left, assetId)).toMatchObject({ kind: "excluded", cause: "resolution_conflict" });
    }
  });

  it("case 15-c: does not redirect a dependency from an overridden loser to its winner", () => {
    const result = resultValue({}, [
      candidateFromDocument(assetDocument("asset-dependent", "requires: [asset-loser]\n"), add()),
      candidateFromDocument(assetDocument("asset-winner"), exclusive("g", { explicitPriority: 2 })),
      candidateFromDocument(assetDocument("asset-loser"), exclusive("g", { explicitPriority: 1 })),
    ]);

    expect(reason(result, "asset-loser")).toMatchObject({ kind: "overridden", overriddenBy: "asset-winner" });
    expect(reason(result, "asset-dependent")).toEqual({ kind: "unavailable", availability: "unavailable", cause: "requirement_overridden", failedRequirements: ["asset-loser"] });
    expect(result.outcome).toBe("resolved");
  });

  it("case 15-d: classifies a disabled in-scope requirement before an out-of-scope alternative", () => {
    const dependent = candidateFromDocument(assetDocument("asset-dependent", "requires: [asset-target]\n"), add());
    const target = candidateFromDocument(assetDocument("asset-target"), add());
    const outOfScopeTarget = candidateFromDocument(assetDocument("asset-target", "scope.role: [author]\n"), add());
    const disable = candidateFromDocument(assetDocument("asset-disable"), {
      ...add(), operation: { kind: "disable", targetAssetId: "asset-target" as AssetId },
    });
    const result = resultValue({ roleId: "reviewer" }, [dependent, outOfScopeTarget, disable, target]);

    expect(reason(result, "asset-dependent")).toEqual({
      kind: "unavailable",
      availability: "unavailable",
      cause: "requirement_disabled",
      failedRequirements: ["asset-target"],
    });
  });

  it("case 15-d-2: classifies a disabled matched requirement before an invalid alternative", () => {
    const dependent = candidateFromDocument(assetDocument("asset-dependent", "requires: [asset-target]\n"), add());
    const target = candidateFromDocument(assetDocument("asset-target", "scope.directory: [/workspace]\n"), add());
    const invalidTarget = candidateFromDocument(assetDocument("asset-target", "scope.directory: [./rel]\n"), add());
    const disable = candidateFromDocument(assetDocument("asset-disable"), {
      ...add(), operation: { kind: "disable", targetAssetId: "asset-target" as AssetId },
    });
    const result = resultValue({ directory: "/workspace" }, [dependent, invalidTarget, disable, target]);

    expect(reason(result, "asset-dependent")).toEqual({
      kind: "unavailable",
      availability: "unavailable",
      cause: "requirement_disabled",
      failedRequirements: ["asset-target"],
    });
  });

  it("case 15-e: drops a failed operation when its issuer is disabled", () => {
    const target = candidateFromDocument(assetDocument("asset-a"), add());
    const invalidOverride = candidateFromDocument(assetDocument("asset-b"), {
      ...add(), operation: { kind: "override", targetAssetId: "asset-a" as AssetId },
    });
    const disable = candidateFromDocument(assetDocument("asset-d"), {
      ...add(), operation: { kind: "disable", targetAssetId: "asset-b" as AssetId },
    });
    const left = resultValue({}, [invalidOverride, disable, target]);
    const right = resultValue({}, [target, disable, invalidOverride]);

    expect(left.conflicts).toEqual(right.conflicts);
    expect(left.evaluations).toEqual(right.evaluations);
    expect(left.conflicts).toHaveLength(0);
    expect(reason(left, "asset-a").kind).toBe("included");
    expect(reason(left, "asset-b")).toEqual({ kind: "disabled", disabledBy: "asset-d" });
  });

  it("case 15-f: leaves a direct requirement target available to its issuer", () => {
    const makeCandidates = () => ({
      a: candidateFromDocument(assetDocument("asset-a", "requires: [asset-c]\n"), {
        ...add(), operation: { kind: "disable", targetAssetId: "asset-c" as AssetId },
      }),
      b: candidateFromDocument(assetDocument("asset-b"), add()),
      c: candidateFromDocument(assetDocument("asset-c"), {
        ...add(), operation: { kind: "disable", targetAssetId: "asset-b" as AssetId },
      }),
      d: candidateFromDocument(assetDocument("asset-d", "requires: [asset-c]\n"), {
        ...add(), operation: { kind: "disable", targetAssetId: "asset-a" as AssetId },
      }),
    });
    const first = makeCandidates();
    const second = makeCandidates();
    const left = resultValue({}, [first.a, first.b, first.c, first.d]);
    const right = resultValue({}, [second.b, second.c, second.a, second.d]);

    expect(left.evaluations).toEqual(right.evaluations);
    expect(left.conflicts).toEqual(right.conflicts);
    expect(left.conflicts).toHaveLength(0);
    expect(reason(left, "asset-a")).toEqual({ kind: "disabled", disabledBy: "asset-d" });
    expect(reason(left, "asset-b")).toEqual({ kind: "disabled", disabledBy: "asset-c" });
    expect(reason(left, "asset-c").kind).toBe("included");
    expect(reason(left, "asset-d").kind).toBe("included");
  });

  it("case 15-g: drops an operation failure when dependency closure disables its issuer", () => {
    const issuer = candidateFromDocument(assetDocument("asset-issuer", "requires: [asset-target]\n"), {
      ...add(), operation: { kind: "disable", targetAssetId: "asset-missing" as AssetId },
    });
    const target = candidateFromDocument(assetDocument("asset-target"), add());
    const disable = candidateFromDocument(assetDocument("asset-disable"), {
      ...add(), operation: { kind: "disable", targetAssetId: "asset-target" as AssetId },
    });
    const result = resultValue({}, [issuer, target, disable]);

    expect(result.outcome).toBe("resolved");
    expect(result.conflicts).toHaveLength(0);
    expect(reason(result, "asset-issuer")).toEqual({
      kind: "unavailable",
      availability: "unavailable",
      cause: "requirement_disabled",
      failedRequirements: ["asset-target"],
    });
    expect(reason(result, "asset-target")).toEqual({ kind: "disabled", disabledBy: "asset-disable" });
  });

  it("case 15-h: traverses a long dependency chain without recursion", () => {
    const template = candidateFromDocument(assetDocument("asset-template"), add());
    const count = 10_000;
    const candidates = Array.from({ length: count }, (_, index) => ({
      ...template,
      assetId: `asset-${index}` as AssetId,
      revision: `revision-${index}` as AssetRevision,
      rule: {
        ...template.rule,
        requires: index + 1 < count ? [`asset-${index + 1}` as AssetId] : [],
      },
    }));
    const result = resultValue({}, candidates);

    expect(result.evaluations).toHaveLength(count);
    expect(result.evaluations.every((item) => item.reason.kind === "included")).toBe(true);
  });

  it("case 15-h-1: traverses a long operation graph without recursion", () => {
    const template = candidateFromDocument(assetDocument("asset-operation-template"), add());
    const count = 10_000;
    const candidates = Array.from({ length: count }, (_, index) => ({
      ...template,
      assetId: `asset-operation-${index}` as AssetId,
      revision: `revision-operation-${index}` as AssetRevision,
      rule: {
        ...template.rule,
        operation: index + 1 < count
          ? { kind: "disable" as const, targetAssetId: `asset-operation-${index + 1}` as AssetId }
          : { kind: "add" as const },
      },
    }));
    const result = resultValue({}, candidates);

    expect(result.evaluations).toHaveLength(count);
    expect(reason(result, "asset-operation-0").kind).toBe("included");
    expect(reason(result, "asset-operation-1")).toEqual({ kind: "disabled", disabledBy: "asset-operation-0" });
    expect(reason(result, `asset-operation-${count - 1}`)).toEqual({ kind: "disabled", disabledBy: `asset-operation-${count - 2}` });
  });

  it("case 15-i: reconciles operation groups independent of candidate order", () => {
    const makeCandidates = () => ({
      a: candidateFromDocument(assetDocument("asset-a"), {
        ...add(), mergeGroup: "group", operation: { kind: "override", targetAssetId: "asset-t" as AssetId },
      }),
      b: candidateFromDocument(assetDocument("asset-b"), {
        ...add(), operation: { kind: "disable", targetAssetId: "asset-t" as AssetId },
      }),
      t: candidateFromDocument(assetDocument("asset-t"), {
        ...add(), mergeGroup: "group", operation: { kind: "disable", targetAssetId: "asset-a" as AssetId },
      }),
    });
    const first = makeCandidates();
    const second = makeCandidates();
    const left = resultValue({}, [first.a, first.b, first.t]);
    const right = resultValue({}, [second.t, second.a, second.b]);

    expect(left.evaluations).toEqual(right.evaluations);
    expect(left.conflicts).toEqual(right.conflicts);
  });

  it("case 15-j: runs dependent closure after operation failure", () => {
    const issuer = candidateFromDocument(assetDocument("asset-issuer"), {
      ...add(), operation: { kind: "override", targetAssetId: "asset-target" as AssetId },
    });
    const dependent = candidateFromDocument(assetDocument("asset-dependent", "requires: [asset-issuer]\n"), add());
    const target = candidateFromDocument(assetDocument("asset-target"), add());
    const result = resultValue({}, [issuer, dependent, target]);

    expect(result.outcome).toBe("conflicted");
    expect(result.conflicts).toEqual([{ kind: "operation_conflict", targetAssetId: "asset-target", involvedAssetIds: ["asset-issuer", "asset-target"] }]);
    expect(reason(result, "asset-issuer")).toMatchObject({ kind: "excluded", cause: "resolution_conflict" });
    expect(reason(result, "asset-dependent")).toEqual({
      kind: "unavailable",
      availability: "unavailable",
      cause: "requirement_invalid",
      failedRequirements: ["asset-issuer"],
    });
  });

  it("case 15-k: runs dependent closure after final operation feedback", () => {
    const dependent = candidateFromDocument(assetDocument("asset-dependent", "requires: [asset-d]\n"), add());
    const a = candidateFromDocument(assetDocument("asset-a"), add());
    const b = candidateFromDocument(assetDocument("asset-b"), { ...add(), operation: { kind: "disable", targetAssetId: "asset-a" as AssetId } });
    const c = candidateFromDocument(assetDocument("asset-c"), { ...add(), operation: { kind: "disable", targetAssetId: "asset-b" as AssetId } });
    const d = candidateFromDocument(assetDocument("asset-d", "requires: [asset-a]\n"), { ...add(), operation: { kind: "disable", targetAssetId: "asset-c" as AssetId } });
    const result = resultValue({}, [dependent, b, c, d, a]);

    expect(reason(result, "asset-d")).toMatchObject({ kind: "excluded", cause: "resolution_conflict" });
    expect(reason(result, "asset-dependent")).toEqual({
      kind: "unavailable",
      availability: "unavailable",
      cause: "requirement_invalid",
      failedRequirements: ["asset-d"],
    });
  });

  it("case 15-l: stabilizes unrelated operations after resolving a cycle", () => {
    const a = candidateFromDocument(assetDocument("asset-a"), { ...add(), operation: { kind: "disable", targetAssetId: "asset-e" as AssetId } });
    const e = candidateFromDocument(assetDocument("asset-e"), { ...add(), operation: { kind: "disable", targetAssetId: "asset-a" as AssetId } });
    const b = candidateFromDocument(assetDocument("asset-b"), { ...add(), operation: { kind: "disable", targetAssetId: "asset-d" as AssetId } });
    const d = candidateFromDocument(assetDocument("asset-d"), { ...add(), operation: { kind: "disable", targetAssetId: "asset-c" as AssetId } });
    const c = candidateFromDocument(assetDocument("asset-c"), add());
    const result = resultValue({}, [a, e, b, d, c]);

    expect(result.conflicts).toEqual([{ kind: "operation_conflict", targetAssetId: "asset-a", involvedAssetIds: ["asset-a", "asset-e"] }]);
    expect(reason(result, "asset-a")).toMatchObject({ kind: "excluded", cause: "resolution_conflict" });
    expect(reason(result, "asset-e")).toMatchObject({ kind: "excluded", cause: "resolution_conflict" });
    expect(reason(result, "asset-d")).toEqual({ kind: "disabled", disabledBy: "asset-b" });
    expect(reason(result, "asset-c").kind).toBe("included");
  });

  it("case 15-m: pins fixed-point invariants for every candidate permutation", () => {
    const makeHealthyCandidates = () => {
      const required = candidateFromDocument(assetDocument("asset-required"), add());
      const target = candidateFromDocument(assetDocument("asset-target"), add());
      const issuer = candidateFromDocument(assetDocument("asset-issuer", "requires: [asset-required]\n"), {
        ...add(), operation: { kind: "disable", targetAssetId: "asset-target" as AssetId },
      });
      const dependent = candidateFromDocument(assetDocument("asset-dependent", "requires: [asset-target]\n"), add());
      return [required, target, issuer, dependent] as const;
    };
    const makeConflictCandidates = () => {
      const target = candidateFromDocument(assetDocument("asset-target"), exclusive("group"));
      const highA = candidateFromDocument(assetDocument("asset-high-a"), {
        ...add(), explicitPriority: 10, mergeGroup: "group",
        operation: { kind: "override", targetAssetId: "asset-target" as AssetId },
      });
      const highB = candidateFromDocument(assetDocument("asset-high-b"), {
        ...add(), explicitPriority: 10, mergeGroup: "group",
        operation: { kind: "override", targetAssetId: "asset-target" as AssetId },
      });
      const lowDisable = candidateFromDocument(assetDocument("asset-low"), {
        ...add(), explicitPriority: 1,
        operation: { kind: "disable", targetAssetId: "asset-target" as AssetId },
      });
      return [target, highA, highB, lowDisable] as const;
    };
    const assertInvariants = (result: ResolutionResult): void => {
      for (const item of result.evaluations) {
        if (item.reason.kind === "included") {
          for (const requiredId of item.candidate.rule.requires) {
            expect(result.evaluations.filter((candidate) =>
              candidate.candidate.assetId === requiredId && candidate.reason.kind === "included")).toHaveLength(1);
          }
        }
        if (item.reason.kind === "excluded" && item.reason.cause === "resolution_conflict") {
          expect(result.conflicts).toContainEqual(item.reason.conflict);
        }
      }
      for (const conflict of result.conflicts) {
        if (conflict.kind === "dependency_cycle" || conflict.kind === "dependency_failure") continue;
        expect(result.evaluations.some((item) =>
          item.reason.kind === "excluded" &&
          item.reason.cause === "resolution_conflict" &&
          item.reason.conflict.kind === conflict.kind &&
          item.reason.conflict.involvedAssetIds.join("\u0000") === conflict.involvedAssetIds.join("\u0000"))).toBe(true);
      }
    };

    const healthy = makeHealthyCandidates();
    const healthyBaseline = resultValue({}, healthy);
    for (const candidates of permutations(healthy)) {
      const result = resultValue({}, candidates);
      expect(result).toEqual(healthyBaseline);
      expect(reason(result, "asset-issuer").kind).toBe("included");
      expect(reason(result, "asset-target")).toEqual({ kind: "disabled", disabledBy: "asset-issuer" });
      assertInvariants(result);
    }

    const conflict = makeConflictCandidates();
    const conflictBaseline = resultValue({}, conflict);
    for (const candidates of permutations(conflict)) {
      const result = resultValue({}, candidates);
      expect(result).toEqual(conflictBaseline);
      expect(result.outcome).toBe("conflicted");
      assertInvariants(result);
    }
  });

  it("case 16: keeps a healthy candidate included beside an unavailable candidate", () => {
    const result = resultValue({}, [
      candidateFromDocument(assetDocument("asset-good"), add()),
      candidateFromDocument(assetDocument("asset-bad", "requires: [asset-missing]\n"), add()),
    ]);

    expect(result.evaluations).toHaveLength(2);
    expect(reason(result, "asset-good").kind).toBe("included");
    expect(reason(result, "asset-bad").kind).toBe("unavailable");
    expect(result.conflicts).toHaveLength(0);
  });

  it("case 17: retains a mandatory dependency failure as a conflict", () => {
    const result = resultValue({}, [
      candidateFromDocument(assetDocument("asset-good"), add()),
      candidateFromDocument(assetDocument("asset-bad", "requires: [asset-missing]\n"), { ...add(), mandatory: true }),
    ]);

    expect(result.outcome).toBe("conflicted");
    expect(result.conflicts).toEqual([{ kind: "dependency_failure", failedRequirement: "asset-missing", involvedAssetIds: ["asset-bad", "asset-missing"] }]);
    expect(reason(result, "asset-bad")).toEqual({ kind: "unavailable", availability: "unavailable", cause: "missing_requirement", failedRequirements: ["asset-missing"] });
    expect(reason(result, "asset-good").kind).toBe("included");
  });

  it("case 17-b: retains a dependency cycle alongside an earlier dependency failure", () => {
    const mandatory = candidateFromDocument(assetDocument("asset-mandatory", "requires: [asset-0, asset-a]\n"), { ...add(), mandatory: true });
    const cycleA = candidateFromDocument(assetDocument("asset-a", "requires: [asset-b]\n"), add());
    const cycleB = candidateFromDocument(assetDocument("asset-b", "requires: [asset-a]\n"), add());
    const result = resultValue({}, [mandatory, cycleA, cycleB]);

    expect(result.outcome).toBe("conflicted");
    expect(result.conflicts).toEqual(expect.arrayContaining([
      { kind: "dependency_cycle", involvedAssetIds: ["asset-a", "asset-b", "asset-mandatory"] },
      { kind: "dependency_failure", failedRequirement: "asset-0", involvedAssetIds: ["asset-0", "asset-a", "asset-mandatory"] },
    ]));
  });

  it("case 17-c: retains a dependency failure when the cycle sorts first", () => {
    const mandatory = candidateFromDocument(assetDocument("asset-mandatory", "requires: [asset-a, asset-z]\n"), { ...add(), mandatory: true });
    const cycleA = candidateFromDocument(assetDocument("asset-a", "requires: [asset-b]\n"), add());
    const cycleB = candidateFromDocument(assetDocument("asset-b", "requires: [asset-a]\n"), add());
    const result = resultValue({}, [mandatory, cycleA, cycleB]);

    expect(result.outcome).toBe("conflicted");
    expect(result.conflicts).toEqual(expect.arrayContaining([
      { kind: "dependency_cycle", involvedAssetIds: ["asset-a", "asset-b", "asset-mandatory"] },
      { kind: "dependency_failure", failedRequirement: "asset-z", involvedAssetIds: ["asset-a", "asset-mandatory", "asset-z"] },
    ]));
    expect(reason(result, "asset-mandatory")).toEqual({
      kind: "unavailable",
      availability: "unavailable",
      cause: "requirement_cycle",
      failedRequirements: ["asset-a", "asset-z"],
    });
  });

  it("case 17-d: propagates a non-cycle failure across a dependency cycle", () => {
    const mandatory = candidateFromDocument(assetDocument("asset-a", "requires: [asset-b]\n"), { ...add(), mandatory: true });
    const cycleMember = candidateFromDocument(assetDocument("asset-b", "requires: [asset-a, asset-missing]\n"), add());
    const result = resultValue({}, [mandatory, cycleMember]);

    expect(result.outcome).toBe("conflicted");
    expect(result.conflicts).toEqual(expect.arrayContaining([
      { kind: "dependency_cycle", involvedAssetIds: ["asset-a", "asset-b"] },
      { kind: "dependency_failure", failedRequirement: "asset-b", involvedAssetIds: ["asset-a", "asset-b"] },
    ]));
    expect(reason(result, "asset-a")).toEqual({
      kind: "unavailable",
      availability: "unavailable",
      cause: "requirement_cycle",
      failedRequirements: ["asset-b"],
    });
  });

  it.each(["case 18", "case 19"])("%s: treats an unknown capability or fallback requirement as missing", (caseName) => {
    const id = caseName === "case 18" ? "asset-requires-capability" : "asset-original";
    const requirement = caseName === "case 18" ? "capability-x" : "asset-fallback";
    const result = resultValue({}, [candidateFromDocument(assetDocument(id, `requires: [${requirement}]\n`), add())]);

    expect(result.outcome).toBe("resolved");
    expect(reason(result, id)).toEqual({ kind: "unavailable", availability: "unavailable", cause: "missing_requirement", failedRequirements: [requirement] });
    expect(result.evaluations.some((item) => item.reason.kind === "included" && item.candidate.assetId !== id)).toBe(false);
  });

  it("case 17.5 directory trailing slash: returns the normalized request scope", () => {
    const result = resultValue({ directory: "/repo/src/" }, [candidateFromDocument(assetDocument("asset-src", "scope.directory: [/repo/src]\n"), add())]);

    expect(result.scope.directory).toBe("/repo/src");
    expect(reason(result, "asset-src")).toMatchObject({ kind: "included", rank: { directoryDepth: 2 } });
  });

  it.each(["\\repo\\src", "C:/repo", "repo/src", "/repo/./src", "/repo/../src"])("case 17.5 directory rejection: rejects %s", (directory) => {
    const result = resolve({ directory }, []);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("invalid_request");
      expect(result.failure.details?.[0]?.code).toBe("invalid_directory");
    }
  });

  it("case 17.5 candidate directory rejection: excludes only the invalid candidate", () => {
    const result = resultValue({ directory: "/workspace" }, [
      candidateFromDocument(assetDocument("asset-invalid", "scope.directory: [./rel]\n"), add()),
      candidateFromDocument(assetDocument("asset-healthy", "scope.directory: [/workspace]\n"), add()),
    ]);

    expect(result.outcome).toBe("resolved");
    expect(reason(result, "asset-invalid")).toEqual({
      kind: "excluded",
      cause: "invalid_directory",
      diagnostics: [{ path: ["snapshot", "candidate", "asset-invalid", "rule", "selectors", "directory"], code: "invalid_directory", message: expect.any(String) }],
    });
    const diagnostics = reason(result, "asset-invalid");
    if (diagnostics.kind === "excluded" && diagnostics.cause === "invalid_directory") {
      expect(diagnostics.diagnostics[0]?.message.length).toBeGreaterThan(0);
    }
    expect(reason(result, "asset-healthy").kind).toBe("included");
    for (const selector of ["/", "/workspace", "/workspace/src"] as const) {
      expect(reason(resultValue({ directory: selector }, [candidateFromDocument(assetDocument("asset-valid", `scope.directory: [${selector}]\n`), add())]), "asset-valid").kind).toBe("included");
    }
  });

  it("case 17.5-a: checks identity payload consistency before invalid-directory partition", () => {
    const valid = candidateFromDocument(assetDocument("asset-payload"), add(), { revision: "shared-revision" });
    const invalidDirectory = withDirectorySelectors(valid, ["./relative"]);
    const contradictory = {
      ...invalidDirectory,
      assetType: "skill" as AssetType,
      loadingTier: "on-demand" as LoadingTier,
    };

    for (const candidates of [[valid, contradictory], [contradictory, valid]] as const) {
      const result = resolve({}, candidates);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.code).toBe("invalid_request");
        expect(result.failure.details?.some((item) => item.path.includes("asset-payload") && item.code === "invalid_value")).toBe(true);
      }
    }
  });

  it.each([
    [["/repo/src/", "/repo/src-extra"], ["/repo/src", "/repo/src-extra"]],
    [["/repo/src", "/repo/src/"], ["/repo/src"]],
  ] as const)("case 17.5 candidate directory post-normalization: canonicalizes %j", (directories, expected) => {
    const base = candidateFromDocument(assetDocument("asset-directory", "scope.directory: [/repo/src]\n"), add());
    const candidate = withDirectorySelectors(base, directories);
    const result = resultValue({ directory: "/repo/src" }, [candidate]);

    expect(evaluation(result, "asset-directory").candidate.rule.selectors.directory).toEqual(expected);
  });

  it("case 17.5 empty selector element: rejects it as an invalid candidate snapshot", () => {
    const base = candidateFromDocument(assetDocument("asset-empty-selector"), add());
    const candidate = { ...base, rule: { ...base.rule, selectors: { ...base.rule.selectors, roleId: [""] } } };
    const result = resolve({ roleId: "reviewer" }, [candidate]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("invalid_request");
      expect(result.failure.details?.[0]?.code).toBe("empty_identifier");
    }
  });

  it("case 17.5 invalid merge shape: rejects an exclusive candidate without a merge group", () => {
    const valid = candidateFromDocument(assetDocument("asset-invalid-merge"), exclusive("g"));
    const { mergeGroup: _mergeGroup, ...ruleWithoutGroup } = valid.rule;
    const invalid = { ...valid, rule: ruleWithoutGroup as ResolutionRule };
    const result = resolve({}, [invalid]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("invalid_request");
      expect(result.failure.details?.[0]?.code).toBe("invalid_merge_group");
    }
  });

  it("case 17.5 out-of-scope operation target: reports an operation conflict without disabling the target", () => {
    const result = resultValue({ roleId: "reviewer" }, [
      candidateFromDocument(assetDocument("asset-issuer", "scope.role: [reviewer]\n"), { ...add(), operation: { kind: "disable", targetAssetId: "asset-target" as AssetId } }),
      candidateFromDocument(assetDocument("asset-target", "scope.role: [author]\n"), add()),
    ]);

    expect(result.outcome).toBe("conflicted");
    expect(result.conflicts[0]).toEqual({ kind: "operation_conflict", targetAssetId: "asset-target", involvedAssetIds: ["asset-issuer", "asset-target"] });
    expect(reason(result, "asset-target")).toEqual({ kind: "excluded", cause: "scope_mismatch", mismatchedAxes: ["roleId"] });
  });

  it("case 17.5 operation conflict: records a lower-ranked operation that loses to another kind", () => {
    const target = candidateFromDocument(assetDocument("asset-target"), exclusive("g"));
    const highDisable = candidateFromDocument(assetDocument("asset-high"), {
      ...add(),
      explicitPriority: 10,
      operation: { kind: "disable", targetAssetId: "asset-target" as AssetId },
      mergeGroup: "g",
    });
    const lowOverride = candidateFromDocument(assetDocument("asset-low"), {
      ...add(),
      explicitPriority: 1,
      operation: { kind: "override", targetAssetId: "asset-target" as AssetId },
      mergeGroup: "g",
    });
    const result = resultValue({}, [lowOverride, target, highDisable]);

    expect(result.outcome).toBe("conflicted");
    expect(result.conflicts).toEqual([{
      kind: "operation_conflict",
      targetAssetId: "asset-target",
      involvedAssetIds: ["asset-high", "asset-low", "asset-target"],
    }]);
    expect(reason(result, "asset-target")).toEqual({ kind: "disabled", disabledBy: "asset-high" });
    expect(reason(result, "asset-low")).toMatchObject({ kind: "excluded", cause: "resolution_conflict" });
  });

  it("case 17.5 operation tie: marks a lower-ranked contrary issuer conflicted", () => {
    const target = candidateFromDocument(assetDocument("asset-target"), exclusive("g"));
    const override = (assetId: string, explicitPriority: number): AssetCandidate => candidateFromDocument(assetDocument(assetId), {
      ...add(),
      explicitPriority,
      operation: { kind: "override", targetAssetId: "asset-target" as AssetId },
      mergeGroup: "g",
    });
    const lowDisable = candidateFromDocument(assetDocument("asset-low"), {
      ...add(),
      explicitPriority: 1,
      operation: { kind: "disable", targetAssetId: "asset-target" as AssetId },
    });
    const result = resultValue({}, [target, lowDisable, override("asset-high-a", 10), override("asset-high-b", 10)]);

    expect(result.outcome).toBe("conflicted");
    expect(result.conflicts).toEqual([{
      kind: "operation_conflict",
      targetAssetId: "asset-target",
      involvedAssetIds: ["asset-high-a", "asset-high-b", "asset-low", "asset-target"],
    }]);
    expect(reason(result, "asset-target").kind).toBe("included");
    expect(reason(result, "asset-low")).toMatchObject({ kind: "excluded", cause: "resolution_conflict" });
  });

  it("case 17.5 candidate order: sorts same-rank additive evaluations by AssetId", () => {
    const makeCandidates = (ids: readonly ["asset-a" | "asset-b" | "asset-c", "asset-a" | "asset-b" | "asset-c", "asset-a" | "asset-b" | "asset-c"]) => ids.map((id) => candidateFromDocument(assetDocument(id), add()));
    const left = resultValue({}, makeCandidates(["asset-c", "asset-a", "asset-b"]));
    const right = resultValue({}, makeCandidates(["asset-b", "asset-c", "asset-a"]));

    expect(left.evaluations.map((item) => item.candidate.assetId)).toEqual(["asset-a", "asset-b", "asset-c"]);
    expect(right.evaluations.map((item) => item.candidate.assetId)).toEqual(["asset-a", "asset-b", "asset-c"]);
    expect(left.conflicts).toHaveLength(0);
    expect(right.conflicts).toHaveLength(0);
  });

  it("case 17.5 exact duplicate: chooses the project/source-a representative", () => {
    const result = resultValue({}, [
      candidateFromDocument(assetDocument("asset-a"), add(), { source: { layer: "global", sourceId: "source-z" } }),
      candidateFromDocument(assetDocument("asset-a"), add(), { source: { layer: "project", sourceId: "source-a" } }),
    ]);

    expect(result.outcome).toBe("resolved");
    expect(result.evaluations).toHaveLength(1);
    expect(result.evaluations[0]?.candidate.source).toEqual({ layer: "project", sourceId: "source-a" });
    expect(result.conflicts).toHaveLength(0);
  });

  it("case 17.5 full DTO projection: accepts a result projected through the shared response schema", () => {
    const result = resultValue({}, [candidateFromDocument(assetDocument("asset-a"), add())]);
    const resolvedContext = {
      scope: result.scope,
      assets: result.evaluations.map(({ candidate, reason: candidateReason }) => ({
        assetId: candidate.assetId,
        revision: candidate.revision,
        assetType: candidate.assetType,
        loadingTier: candidate.loadingTier,
        reason: toResolutionReasonDto(candidateReason),
      })),
      conflicts: result.conflicts.map(toResolutionConflictDto),
      cost: { totalTokenEstimate: 0, includedAssetCount: 1, excludedAssetCount: 0 },
      resolvedAt: "2026-08-30T01:02:03+09:00",
    };
    const firstAsset = resolvedContext.assets[0];
    if (firstAsset === undefined) throw new Error("Expected a projected asset.");
    expect(parseResolvedContextDto(resolvedContext)).toEqual(resolvedContext);
    expect(tryParseResolvedContextDto({ ...resolvedContext, unknown: true }).ok).toBe(false);
    expect(tryParseResolvedContextDto({ ...resolvedContext, assets: [{ ...firstAsset, reason: { kind: "included", explanation: "" } }] }).ok).toBe(false);
    expect(tryParseResolvedContextDto({ ...resolvedContext, assets: [{ ...firstAsset, reason: { kind: "unavailable", explanation: "bad", availability: "available" } }] }).ok).toBe(false);
  });

  it("case 17.5 conflict detail carrier: uses canonical IDs in detail order", () => {
    const result = resultValue({}, [
      candidateFromDocument(assetDocument("asset-b"), exclusive("g")),
      candidateFromDocument(assetDocument("asset-a"), exclusive("g")),
    ]);
    const conflict = result.conflicts.find((item) => item.kind === "exclusive_tie");
    if (conflict === undefined) throw new Error("Expected an exclusive tie.");

    const details = toResolutionConflictDetails(conflict);
    expect(details).toEqual([
      { path: ["resolution", "conflict", "exclusive_tie", "asset-a"], code: "exclusive_tie", message: expect.any(String) },
      { path: ["resolution", "conflict", "exclusive_tie", "asset-b"], code: "exclusive_tie", message: expect.any(String) },
    ]);
    expect(details.every((item) => item.message.length > 0)).toBe(true);
  });

  it("case 17.5 result clock boundary: contains only semantic result fields", () => {
    const result = resultValue({}, []);

    expect(Object.keys(result).sort()).toEqual(["conflicts", "evaluations", "outcome", "scope"]);
    expect("resolvedAt" in result).toBe(false);
    expect("cost" in result).toBe(false);
    expect("body" in result).toBe(false);
  });

  it("S1: marks a missing required capability unavailable", () => {
    const candidate = candidateFromDocument(assetDocument("skill-required", "", "skill"), {
      ...add(),
      capabilityDependencies: [{ strength: "required", capability: capabilityReference("cap-required") }],
    });
    const result = resultValue({}, [candidate], capabilityContext([{ id: "cap-required" }], []));

    expect(reason(result, "skill-required")).toMatchObject({
      kind: "unavailable",
      availability: "unavailable",
      cause: "capability_unavailable",
      failedCapabilities: [capabilityId("cap-required")],
    });
  });

  it("S2: retains a candidate with an optional capability degradation", () => {
    const candidate = candidateFromDocument(assetDocument("skill-optional", "", "skill"), {
      ...add(),
      capabilityDependencies: [{ strength: "optional", capability: capabilityReference("cap-optional") }],
    });
    const result = resultValue({}, [candidate], capabilityContext([{ id: "cap-optional" }], []));

    expect(reason(result, "skill-optional")).toMatchObject({
      kind: "included",
      degradedCapabilities: [{ capabilityId: capabilityId("cap-optional"), strength: "optional" }],
      degradedInfo: { reasons: [expect.stringContaining("cap-optional")] },
    });
  });

  it("S3: retains a candidate with a preferred capability degradation", () => {
    const candidate = candidateFromDocument(assetDocument("skill-preferred", "", "skill"), {
      ...add(),
      capabilityDependencies: [{ strength: "preferred", capability: capabilityReference("cap-preferred") }],
    });
    const result = resultValue({}, [candidate], capabilityContext([{ id: "cap-preferred" }], []));

    expect(reason(result, "skill-preferred")).toMatchObject({
      kind: "included",
      degradedCapabilities: [{ capabilityId: capabilityId("cap-preferred"), strength: "preferred" }],
    });
  });

  it("S4: records adoption of a fallback for a required capability", () => {
    const candidate = candidateFromDocument(assetDocument("skill-fallback", "", "skill"), {
      ...add(),
      capabilityDependencies: [
        { strength: "required", capability: capabilityReference("cap-primary") },
        { strength: "fallback", capability: capabilityReference("cap-fallback"), fallbackFor: capabilityReference("cap-primary") },
      ],
    });
    const result = resultValue({}, [candidate], capabilityContext(
      [{ id: "cap-fallback" }, { id: "cap-primary" }],
      [capabilityOffer("cap-fallback")],
    ));

    expect(reason(result, "skill-fallback")).toMatchObject({
      kind: "included",
      degradedCapabilities: [{
        capabilityId: capabilityId("cap-primary"),
        strength: "required",
        fallbackCapabilityId: capabilityId("cap-fallback"),
      }],
      degradedInfo: { reasons: [expect.stringContaining("cap-fallback")] },
    });
  });

  it("S5: marks a required capability unavailable when its fallback is also absent", () => {
    const candidate = candidateFromDocument(assetDocument("skill-no-fallback", "", "skill"), {
      ...add(),
      capabilityDependencies: [
        { strength: "required", capability: capabilityReference("cap-primary") },
        { strength: "fallback", capability: capabilityReference("cap-fallback"), fallbackFor: capabilityReference("cap-primary") },
      ],
    });
    const result = resultValue({}, [candidate], capabilityContext(
      [{ id: "cap-fallback" }, { id: "cap-primary" }],
      [],
    ));

    expect(reason(result, "skill-no-fallback")).toMatchObject({
      kind: "unavailable",
      cause: "capability_unavailable",
      failedCapabilities: [capabilityId("cap-fallback"), capabilityId("cap-primary")],
    });
  });

  it("S6: treats an omitted capability context as an empty offer set", () => {
    const candidate = candidateFromDocument(assetDocument("skill-no-context", "", "skill"), {
      ...add(),
      capabilityDependencies: [{ strength: "required", capability: capabilityReference("cap-required") }],
    });

    expect(reason(resultValue({}, [candidate]), "skill-no-context")).toMatchObject({
      kind: "unavailable",
      cause: "capability_unavailable",
    });
  });

  it("S7: does not apply an operation from a hard-failed capability issuer", () => {
    const issuer = candidateFromDocument(assetDocument("skill-hard-issuer", "", "skill"), {
      ...add(),
      operation: { kind: "disable", targetAssetId: "asset-target" as AssetId },
      capabilityDependencies: [{ strength: "required", capability: capabilityReference("cap-required") }],
    });
    const target = candidateFromDocument(assetDocument("asset-target", "", "skill"), add());
    const result = resultValue({}, [issuer, target], capabilityContext([{ id: "cap-required" }], []));

    expect(reason(result, "skill-hard-issuer")).toMatchObject({ kind: "unavailable" });
    expect(reason(result, "asset-target")).toMatchObject({ kind: "included" });
  });

  it("S8: applies an operation from a soft-degraded capability issuer", () => {
    const issuer = candidateFromDocument(assetDocument("skill-soft-issuer", "", "skill"), {
      ...add(),
      operation: { kind: "disable", targetAssetId: "asset-target" as AssetId },
      capabilityDependencies: [{ strength: "optional", capability: capabilityReference("cap-optional") }],
    });
    const target = candidateFromDocument(assetDocument("asset-target", "", "skill"), add());
    const result = resultValue({}, [issuer, target], capabilityContext([{ id: "cap-optional" }], []));

    expect(reason(result, "skill-soft-issuer")).toMatchObject({ kind: "included", degradedCapabilities: [{ strength: "optional" }] });
    expect(reason(result, "asset-target")).toEqual({ kind: "disabled", disabledBy: "skill-soft-issuer" });
  });

  it("S9: records a mandatory capability failure as a conflict", () => {
    const candidate = candidateFromDocument(assetDocument("skill-mandatory", "", "skill"), {
      ...add(),
      mandatory: true,
      capabilityDependencies: [{ strength: "required", capability: capabilityReference("cap-mandatory") }],
    });
    const result = resultValue({}, [candidate], capabilityContext([{ id: "cap-mandatory" }], []));

    expect(result.outcome).toBe("conflicted");
    expect(result.conflicts).toEqual([{
      kind: "capability_failure",
      failedCapabilities: [capabilityId("cap-mandatory")],
      involvedAssetIds: ["skill-mandatory"],
    }]);
  });

  it("S10: does not combine features from separate offers", () => {
    const candidate = candidateFromDocument(assetDocument("skill-partial-offers", "", "skill"), {
      ...add(),
      capabilityDependencies: [{ strength: "required", capability: capabilityReference("cap-feature", ["read", "write"]) }],
    });
    const result = resultValue({}, [candidate], capabilityContext(
      [{ id: "cap-feature", features: ["read", "write"] }],
      [capabilityOffer("cap-feature", ["read"]), capabilityOffer("cap-feature", ["write"])],
    ));

    expect(reason(result, "skill-partial-offers")).toMatchObject({ kind: "unavailable", cause: "capability_unavailable" });
  });

  it("S11: treats same-identity candidates with different capability relations as a conflict", () => {
    const source = { layer: "global" as const, sourceId: "same-source" };
    const optional = candidateFromDocument(assetDocument("skill-same-identity", "", "skill"), {
      ...add(),
      capabilityDependencies: [{ strength: "optional", capability: capabilityReference("cap-a") }],
    }, { revision: "same-revision", source });
    const preferred = candidateFromDocument(assetDocument("skill-same-identity", "", "skill"), {
      ...add(),
      capabilityDependencies: [{ strength: "preferred", capability: capabilityReference("cap-a") }],
    }, { revision: "same-revision", source });
    const result = resultValue({}, [preferred, optional], capabilityContext([{ id: "cap-a" }], []));

    expect(result.outcome).toBe("conflicted");
    expect(result.conflicts).toEqual([{ kind: "duplicate_identity", assetId: "skill-same-identity", involvedAssetIds: ["skill-same-identity"] }]);
    expect(result.evaluations).toHaveLength(2);
    expect(result.evaluations.every((item) => item.reason.kind === "excluded" && item.reason.cause === "resolution_conflict")).toBe(true);
  });

  it("S12: rejects capability dependencies on a type outside the capability policy", () => {
    const candidate = candidateFromDocument(assetDocument("rule-with-capability", "", "rule"), {
      ...add(),
      capabilityDependencies: [{ strength: "required", capability: capabilityReference("cap-rule") }],
    });
    const result = resolve({}, [candidate]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("invalid_request");
      expect(result.failure.details?.some((item) => item.code === "capability_dependencies_not_allowed")).toBe(true);
    }
  });

  it("S13: rejects an undeclared capability feature on an in-scope candidate", () => {
    const candidate = candidateFromDocument(assetDocument("skill-in-scope", "", "skill"), {
      ...add(),
      capabilityDependencies: [{ strength: "required", capability: capabilityReference("cap-feature", ["writ"]) }],
    });
    const result = resolve({}, [candidate], capabilityContext(
      [{ id: "cap-feature", features: ["read", "write"] }],
      [capabilityOffer("cap-feature", ["read", "write"])],
    ));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("invalid_request");
      expect(result.failure.details?.map((item) => item.path)).toContainEqual([
        "snapshot", "candidate", "skill-in-scope", "rule", "capabilityDependencies", "0", "capability", "features",
      ]);
    }
  });

  it("S14: rejects an undeclared capability feature on a candidate outside the scope", () => {
    const candidate = candidateFromDocument(assetDocument("skill-out-of-scope", "scope.role: [author]\n", "skill"), {
      ...add(),
      capabilityDependencies: [{ strength: "required", capability: capabilityReference("cap-feature", ["writ"]) }],
    });
    const result = resolve({ roleId: "reviewer" }, [candidate], capabilityContext(
      [{ id: "cap-feature", features: ["read", "write"] }],
      [capabilityOffer("cap-feature", ["read", "write"])],
    ));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.details?.some((item) => item.code === "unknown_capability_feature")).toBe(true);
    }
  });

  it("S15: roots capability context diagnostics at the input field", () => {
    const result = resolve({}, [], capabilityContext([{ id: "cap-a" }], [capabilityOffer("cap-b")]));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.details?.map((item) => item.path)).toContainEqual([
        "capabilityContext", "offers", "0", "capabilityId",
      ]);
    }
  });

  it("S16: propagates a capability failure across a dependency cycle", () => {
    const mandatory = candidateFromDocument(assetDocument("skill-a", "requires: [skill-b]\n", "skill"), {
      ...add(),
      mandatory: true,
    });
    const cycleMember = candidateFromDocument(assetDocument("skill-b", "requires: [skill-a]\n", "skill"), {
      ...add(),
      capabilityDependencies: [{ strength: "required", capability: capabilityReference("cap-cycle") }],
    });
    const result = resultValue({}, [mandatory, cycleMember], capabilityContext([{ id: "cap-cycle" }], []));

    expect(result.outcome).toBe("conflicted");
    expect(result.conflicts).toEqual(expect.arrayContaining([
      { kind: "capability_failure", failedCapabilities: [capabilityId("cap-cycle")], involvedAssetIds: ["skill-a"] },
      { kind: "dependency_cycle", involvedAssetIds: ["skill-a", "skill-b"] },
    ]));
    expect(reason(result, "skill-a")).toMatchObject({
      kind: "unavailable",
      cause: "requirement_cycle",
      failedCapabilities: [capabilityId("cap-cycle")],
    });
  });
});
