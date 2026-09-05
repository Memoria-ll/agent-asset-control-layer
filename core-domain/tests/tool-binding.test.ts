import { describe, expect, it } from "vitest";
import {
  buildCapabilityCatalog,
  parseAssetDocument,
  resolveCapabilityBindings,
  resolveScope,
  toAssetCandidate,
  validateAsset,
} from "../src/index.ts";
import type { AssetRevision, ProjectId, RoleId, StageId, TaskTypeId, WorkflowId } from "@aacl/shared";
import type {
  CapabilityId,
  CapabilityFeatureId,
  ProjectToolBinding,
  ResolveCapabilityBindingsInput,
  ResolutionContext,
  ToolBindingId,
  ToolId,
  ToolProviderId,
} from "../src/index.ts";

const capabilityId = (value: string): CapabilityId => value as CapabilityId;
const featureId = (value: string): CapabilityFeatureId => value as CapabilityFeatureId;
const bindingId = (value: string): ToolBindingId => value as ToolBindingId;

const catalog = () => {
  const result = buildCapabilityCatalog([
    { capabilityId: capabilityId("browser"), displayName: "Browser", features: [featureId("read")] },
    { capabilityId: capabilityId("filesystem"), displayName: "Filesystem", features: [] },
  ]);
  if (!result.ok) throw new Error(result.failure.message);
  return result.value;
};

const projectId = (value: string): ProjectId => value as ProjectId;
const workflowId = (value: string): WorkflowId => value as WorkflowId;
const stageId = (value: string): StageId => value as StageId;
const roleId = (value: string): RoleId => value as RoleId;
const taskTypeId = (value: string): TaskTypeId => value as TaskTypeId;
const context = (values: ResolutionContext = { projectId: projectId("project-a") }): ResolutionContext => values;
const target = (toolProviderId: string, toolId?: string) => toolId === undefined
  ? { kind: "provider" as const, toolProviderId: toolProviderId as ToolProviderId }
  : { kind: "tool" as const, toolProviderId: toolProviderId as ToolProviderId, toolId: toolId as ToolId };
const binding = (id: string, owningProjectId: string, toolId: string, extra: Partial<ProjectToolBinding> = {}): ProjectToolBinding => ({
  bindingId: bindingId(id),
  projectId: projectId(owningProjectId),
  capability: { capabilityId: capabilityId("browser"), features: [featureId("read")] },
  target: target("provider", toolId),
  enabled: true,
  ...extra,
});

const expectValue = <Value>(result: { readonly ok: boolean; readonly value?: Value; readonly failure?: { readonly message: string } }): Value => {
  expect(result.ok).toBe(true);
  if (!result.ok || result.value === undefined) throw new Error(result.failure?.message ?? "Expected success.");
  return result.value;
};

describe("resolveCapabilityBindings", () => {
  it("separates project targets and produces the Resolver context", () => {
    const resultA = expectValue(resolveCapabilityBindings({
      context: context(),
      catalog: catalog(),
      bindings: [binding("b", "project-b", "tool-b"), binding("a", "project-a", "tool-a")],
      observations: [
        { target: target("provider", "tool-a"), state: "available" },
        { target: target("provider", "tool-b"), state: "available" },
      ],
      permissions: [
        { bindingId: bindingId("a"), decision: "allowed" },
        { bindingId: bindingId("b"), decision: "allowed" },
      ],
    }));
    expect(resultA.executionCandidates.map((candidate) => candidate.target)).toEqual([
      target("provider", "tool-a"),
    ]);
    expect(resultA.capabilityContext.offers).toEqual([{
      capabilityId: capabilityId("browser"), features: [featureId("read")], permission: "allowed",
    }]);

    const resultB = expectValue(resolveCapabilityBindings({
      context: context({ projectId: projectId("project-b") }),
      catalog: catalog(),
      bindings: [binding("b", "project-b", "tool-b"), binding("a", "project-a", "tool-a")],
      observations: [
        { target: target("provider", "tool-a"), state: "available" },
        { target: target("provider", "tool-b"), state: "available" },
      ],
      permissions: [
        { bindingId: bindingId("a"), decision: "allowed" },
        { bindingId: bindingId("b"), decision: "allowed" },
      ],
    }));
    expect(resultB.executionCandidates.map((candidate) => candidate.target)).toEqual([
      target("provider", "tool-b"),
    ]);
  });

  it("fails closed when a permission scope axis is absent", () => {
    const result = expectValue(resolveCapabilityBindings({
      context: context(),
      catalog: catalog(),
      bindings: [binding("a", "project-a", "tool-a", { scope: { workflowId: [workflowId("review")] } })],
      observations: [{ target: target("provider", "tool-a"), state: "available" }],
      permissions: [{ bindingId: bindingId("a"), decision: "allowed" }],
    }));
    expect(result.executionCandidates).toEqual([]);
    expect(result.evaluations[0]).toMatchObject({ scope: "out_of_scope", eligible: false });
    expect(result.evaluations[0]?.reasons).toContainEqual({ kind: "context_missing", axis: "workflowId" });
    expect(result.capabilityResults[0]).toMatchObject({ availability: "unavailable", reasons: [{ kind: "no_applicable_binding" }] });
  });

  it.each(["workflowId", "stageId", "roleId", "taskTypeId"] as const)("matches, rejects, and fail-closes the %s permission axis", (axis) => {
    const scoped = binding("a", "project-a", "tool-a", { scope: { [axis]: ["selected"] } });
    const makeInput = (axisValue?: string) => ({
      context: context({
        projectId: projectId("project-a"),
        ...(axisValue === undefined ? {} : axis === "workflowId" ? { workflowId: workflowId(axisValue) } : axis === "stageId" ? { stageId: stageId(axisValue) } : axis === "roleId" ? { roleId: roleId(axisValue) } : { taskTypeId: taskTypeId(axisValue) }),
      }),
      catalog: catalog(),
      bindings: [scoped],
      observations: [{ target: target("provider", "tool-a"), state: "available" as const }],
      permissions: [{ bindingId: bindingId("a"), decision: "allowed" as const }],
    });
    expect(expectValue(resolveCapabilityBindings(makeInput("selected"))).executionCandidates).toHaveLength(1);
    expect(expectValue(resolveCapabilityBindings(makeInput("other"))).executionCandidates).toHaveLength(0);
    const missing = expectValue(resolveCapabilityBindings(makeInput()));
    expect(missing.evaluations[0]?.reasons).toContainEqual({ kind: "context_missing", axis });
    expect(missing.executionCandidates).toHaveLength(0);
  });

  it.each([
    ["available", "allowed", true, "allowed", "allowed", 1],
    ["available", "denied", false, "denied", "denied", 1],
    ["available", "unknown", false, "unknown", "denied", 1],
    ["unavailable", "allowed", false, "unknown", undefined, 0],
    ["unavailable", "denied", false, "unknown", undefined, 0],
    ["unavailable", "unknown", false, "unknown", undefined, 0],
    ["unknown", "allowed", false, "unknown", undefined, 0],
    ["unknown", "denied", false, "unknown", undefined, 0],
    ["unknown", "unknown", false, "unknown", undefined, 0],
  ] as const)("combines observation %s and permission %s", (observation, permission, eligible, aggregatePermission, offerPermission, offerCount) => {
    const result = expectValue(resolveCapabilityBindings({
      context: context(),
      catalog: catalog(),
      bindings: [binding("a", "project-a", "tool-a")],
      observations: [{ target: target("provider", "tool-a"), state: observation }],
      permissions: [{ bindingId: bindingId("a"), decision: permission }],
    }));
    expect(result.evaluations[0]?.eligible).toBe(eligible);
    expect(result.capabilityResults[0]?.permission).toBe(aggregatePermission);
    expect(result.executionCandidates).toHaveLength(eligible ? 1 : 0);
    if (eligible) expect(result.evaluations[0]?.reasons).toContainEqual({ kind: "eligible" });
    if (permission === "denied") expect(result.evaluations[0]?.reasons).toContainEqual({ kind: "permission_denied" });
    if (permission === "unknown") expect(result.evaluations[0]?.reasons).toContainEqual({ kind: "permission_unknown" });
    if (observation === "unavailable") expect(result.evaluations[0]?.reasons).toContainEqual({ kind: "observation_unavailable" });
    if (observation === "unknown") expect(result.evaluations[0]?.reasons).toContainEqual({ kind: "observation_unknown" });
    expect(result.capabilityContext.offers).toHaveLength(offerCount);
    expect(result.capabilityContext.offers[0]?.permission).toBe(offerPermission);
    expect(Object.keys(result.capabilityContext.offers[0] ?? {}).sort()).toEqual(offerCount === 1
      ? ["capabilityId", "features", "permission"]
      : []);
  });

  it("distinguishes missing observation and permission, and excludes disabled bindings", () => {
    const missingObservation = expectValue(resolveCapabilityBindings({
      context: context(), catalog: catalog(), bindings: [binding("a", "project-a", "tool-a")], observations: [],
      permissions: [{ bindingId: bindingId("a"), decision: "allowed" }],
    }));
    expect(missingObservation.evaluations[0]).toMatchObject({ observation: "missing", permission: "allowed", eligible: false });
    expect(missingObservation.evaluations[0]?.reasons).toContainEqual({ kind: "observation_missing" });
    expect(missingObservation.capabilityResults[0]).toMatchObject({ availability: "unavailable", permission: "unknown", reasons: [{ kind: "no_available_binding" }] });

    const missingPermission = expectValue(resolveCapabilityBindings({
      context: context(), catalog: catalog(), bindings: [binding("a", "project-a", "tool-a")],
      observations: [{ target: target("provider", "tool-a"), state: "available" }], permissions: [],
    }));
    expect(missingPermission.evaluations[0]).toMatchObject({ observation: "available", permission: "unknown", eligible: false });
    expect(missingPermission.evaluations[0]?.reasons).toContainEqual({ kind: "permission_unknown" });
    expect(missingPermission.capabilityResults[0]).toMatchObject({ availability: "available", permission: "unknown" });
    expect(missingPermission.capabilityContext.offers[0]?.permission).toBe("denied");

    const disabled = expectValue(resolveCapabilityBindings({
      context: context(), catalog: catalog(), bindings: [binding("a", "project-a", "tool-a", { enabled: false })],
      observations: [{ target: target("provider", "tool-a"), state: "available" }],
      permissions: [{ bindingId: bindingId("a"), decision: "allowed" }],
    }));
    expect(disabled.evaluations[0]).toMatchObject({ enabled: false, eligible: false });
    expect(disabled.evaluations[0]?.reasons).toContainEqual({ kind: "binding_disabled" });
    expect(disabled.capabilityResults[0]).toMatchObject({ availability: "unavailable", reasons: [{ kind: "no_applicable_binding" }] });
  });

  it("reports project and selector scope failures", () => {
    const make = (value: ResolutionContext, scoped: ProjectToolBinding = binding("a", "project-a", "tool-a")) => expectValue(resolveCapabilityBindings({
      context: value, catalog: catalog(), bindings: [scoped],
      observations: [{ target: target("provider", "tool-a"), state: "available" }],
      permissions: [{ bindingId: bindingId("a"), decision: "allowed" }],
    }));
    expect(make({}).evaluations[0]?.reasons).toContainEqual({ kind: "project_context_missing" });
    expect(make({ projectId: projectId("project-b") }).evaluations[0]?.reasons).toContainEqual({ kind: "project_mismatch" });
    expect(make(context(), binding("a", "project-a", "tool-a", { scope: { roleId: [roleId("reviewer")] } })).evaluations[0]?.reasons).toContainEqual({ kind: "context_missing", axis: "roleId" });
    expect(make(context({ roleId: roleId("author") }), binding("a", "project-a", "tool-a", { scope: { roleId: [roleId("reviewer")] } })).evaluations[0]?.reasons).toContainEqual({ kind: "scope_mismatch", axis: "roleId" });
  });

  it("keeps denied diagnostics while retaining eligible candidates in a mixed group", () => {
    const result = expectValue(resolveCapabilityBindings({
      context: context(),
      catalog: catalog(),
      bindings: [binding("denied", "project-a", "tool-denied"), binding("allowed", "project-a", "tool-allowed")],
      observations: [
        { target: target("provider", "tool-denied"), state: "available" },
        { target: target("provider", "tool-allowed"), state: "available" },
      ],
      permissions: [
        { bindingId: bindingId("denied"), decision: "denied" },
        { bindingId: bindingId("allowed"), decision: "allowed" },
      ],
    }));
    expect(result.capabilityResults[0]).toMatchObject({ permission: "allowed", eligibleBindingIds: [bindingId("allowed")] });
    expect(result.evaluations.find((evaluation) => evaluation.bindingId === bindingId("denied"))).toMatchObject({ eligible: false, permission: "denied" });
  });

  it("is independent of input array order", () => {
    const input = {
      context: context(),
      catalog: catalog(),
      bindings: [binding("b", "project-a", "tool-b"), binding("a", "project-a", "tool-a", {
        capability: { capabilityId: capabilityId("filesystem") },
      })],
      observations: [
        { target: target("provider", "tool-b"), state: "available" as const },
        { target: target("provider", "tool-a"), state: "available" as const },
      ],
      permissions: [
        { bindingId: bindingId("b"), decision: "allowed" as const },
        { bindingId: bindingId("a"), decision: "denied" as const },
      ],
    };
    const reversed = expectValue(resolveCapabilityBindings({
      ...input,
      bindings: [...input.bindings].reverse(),
      observations: [...input.observations].reverse(),
      permissions: [...input.permissions].reverse(),
    }));
    expect(reversed).toEqual(expectValue(resolveCapabilityBindings(input)));
  });

  it("rejects strict invalid records", () => {
    const base: ResolveCapabilityBindingsInput = {
      context: context(), catalog: catalog(), bindings: [binding("a", "project-a", "tool-a")],
      observations: [{ target: target("provider", "tool-a"), state: "available" }],
      permissions: [{ bindingId: bindingId("a"), decision: "allowed" }],
    };
    const unknownBindingKey = { ...base.bindings[0], extra: true };
    const unknownTargetKey = { ...target("provider", "tool-a"), extra: true };
    const unknownScopeKey = { workflowId: [workflowId("review")], extra: true };
    const cases: readonly [unknown, string][] = [
      [{ ...base, extra: true }, "unknown_key"],
      [{ ...base, bindings: [unknownBindingKey] }, "unknown_key"],
      [{ ...base, bindings: [{ ...base.bindings[0], target: unknownTargetKey }] }, "unknown_key"],
      [{ ...base, bindings: [{ ...base.bindings[0], scope: unknownScopeKey }] }, "unknown_key"],
      [{ ...base, observations: [{ target: target("provider", "tool-a"), state: "available", extra: true }] }, "unknown_key"],
      [{ ...base, permissions: [{ bindingId: bindingId("a"), decision: "allowed", extra: true }] }, "unknown_key"],
      [{ ...base, bindings: [{ ...base.bindings[0], bindingId: "" }] }, "invalid_tool_binding_id"],
      [{ ...base, bindings: [{ ...base.bindings[0], projectId: "" }] }, "invalid_project_id"],
      [{ ...base, bindings: [{ ...base.bindings[0], scope: { workflowId: [] } }] }, "invalid_scope_selector"],
      [{ ...base, bindings: [{ ...base.bindings[0], scope: { workflowId: [workflowId("b"), workflowId("a")] } }] }, "non_canonical_scope_selector"],
      [{ ...base, bindings: [{ ...base.bindings[0], scope: { workflowId: [workflowId("a"), workflowId("a")] } }] }, "non_canonical_scope_selector"],
      [{ ...base, bindings: [{ ...base.bindings[0], target: { kind: "other" } }] }, "invalid_target_kind"],
      [{ ...base, bindings: [{ ...base.bindings[0], target: { kind: "tool", toolProviderId: "", toolId: "tool" } }] }, "invalid_tool_provider_id"],
      [{ ...base, observations: [{ target: target("provider", "tool-a"), state: "other" }] }, "invalid_observation_state"],
      [{ ...base, permissions: [{ bindingId: bindingId("a"), decision: "other" }] }, "invalid_permission_decision"],
      [{ ...base, bindings: [base.bindings[0], base.bindings[0]] }, "duplicate_binding_id"],
      [{ ...base, observations: [...base.observations, ...base.observations] }, "duplicate_observation_target"],
      [{ ...base, permissions: [...base.permissions, ...base.permissions] }, "duplicate_permission"],
      [{ ...base, permissions: [{ bindingId: bindingId("missing"), decision: "allowed" }] }, "unknown_binding_id"],
      [{ ...base, bindings: [{ ...base.bindings[0], capability: { capabilityId: capabilityId("missing") } }] }, "unknown_capability_id"],
      [{ ...base, bindings: [{ ...base.bindings[0], capability: { capabilityId: capabilityId("browser"), features: [featureId("write")] } }] }, "unknown_capability_feature"],
    ];
    for (const [invalid, expectedCode] of cases) {
      const result = resolveCapabilityBindings(invalid as unknown as ResolveCapabilityBindingsInput);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.code).toBe("invalid_request");
        expect(result.failure.details?.map(({ code }) => code)).toContain(expectedCode);
      }
    }

    const invalidCatalog = new Map([[capabilityId("other"), catalog().get(capabilityId("browser"))!]]);
    const catalogResult = resolveCapabilityBindings({ ...base, catalog: invalidCatalog });
    expect(catalogResult.ok).toBe(false);
    if (!catalogResult.ok) expect(catalogResult.failure.details).toContainEqual(expect.objectContaining({
      path: ["catalog", "other", "capabilityId"],
      code: "catalog_key_mismatch",
    }));
  });

  it("passes the generated context through the real resolver path", () => {
    const bindingResult = expectValue(resolveCapabilityBindings({
      context: context(),
      catalog: catalog(),
      bindings: [binding("a", "project-a", "tool-a")],
      observations: [{ target: target("provider", "tool-a"), state: "available" }],
      permissions: [{ bindingId: bindingId("a"), decision: "allowed" }],
    }));
    const parsed = expectValue(parseAssetDocument(`---
id: skill-binding
type: skill
schema-version: 2
tier: core
capability.required: [browser]
capability.features.browser: [read]
---
`));
    const asset = expectValue(validateAsset(parsed));
    const candidate = expectValue(toAssetCandidate(asset, {
      revision: "revision-skill-binding" as AssetRevision,
      source: { layer: "global", sourceId: "fixture" },
    }));
    const resolved = resolveScope({
      context: { executionMode: "advisory_preparation", workflow: { kind: "none" } },
      snapshot: { candidates: [candidate] },
      capabilityContext: bindingResult.capabilityContext,
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.evaluations[0]?.reason).toMatchObject({ kind: "included" });

    const deniedBinding = expectValue(resolveCapabilityBindings({
      context: context(), catalog: catalog(), bindings: [binding("a", "project-a", "tool-a")],
      observations: [{ target: target("provider", "tool-a"), state: "available" }],
      permissions: [{ bindingId: bindingId("a"), decision: "denied" }],
    }));
    const denied = resolveScope({
      context: { executionMode: "advisory_preparation", workflow: { kind: "none" } }, snapshot: { candidates: [candidate] },
      capabilityContext: deniedBinding.capabilityContext,
    });
    expect(denied.ok).toBe(true);
    if (denied.ok) expect(denied.value.evaluations[0]?.reason).toMatchObject({ kind: "unavailable", cause: "capability_not_allowed" });

    const absentBinding = expectValue(resolveCapabilityBindings({
      context: context(), catalog: catalog(), bindings: [binding("a", "project-a", "tool-a")], observations: [], permissions: [],
    }));
    const absent = resolveScope({
      context: { executionMode: "advisory_preparation", workflow: { kind: "none" } }, snapshot: { candidates: [candidate] },
      capabilityContext: absentBinding.capabilityContext,
    });
    expect(absent.ok).toBe(true);
    if (absent.ok) expect(absent.value.evaluations[0]?.reason).toMatchObject({ kind: "unavailable", cause: "capability_unavailable" });

    const fallbackBinding = expectValue(resolveCapabilityBindings({
      context: context(), catalog: catalog(),
      bindings: [binding("primary", "project-a", "tool-a"), binding("fallback", "project-a", "tool-fallback", { capability: { capabilityId: capabilityId("filesystem") } })],
      observations: [
        { target: target("provider", "tool-a"), state: "unavailable" },
        { target: target("provider", "tool-fallback"), state: "available" },
      ],
      permissions: [
        { bindingId: bindingId("primary"), decision: "allowed" },
        { bindingId: bindingId("fallback"), decision: "allowed" },
      ],
    }));
    const fallbackParsed = expectValue(parseAssetDocument(`---
id: skill-binding-fallback
type: skill
schema-version: 2
tier: core
capability.required: [browser]
capability.fallback.browser: filesystem
capability.features.browser: [read]
---
`));
    const fallbackCandidate = expectValue(toAssetCandidate(expectValue(validateAsset(fallbackParsed)), {
      revision: "revision-skill-binding-fallback" as AssetRevision,
      source: { layer: "global", sourceId: "fixture-fallback" },
    }));
    const fallbackResolved = resolveScope({
      context: { executionMode: "advisory_preparation", workflow: { kind: "none" } }, snapshot: { candidates: [fallbackCandidate] },
      capabilityContext: fallbackBinding.capabilityContext,
    });
    expect(fallbackResolved.ok).toBe(true);
    if (fallbackResolved.ok) expect(fallbackResolved.value.evaluations[0]?.reason).toMatchObject({
      kind: "included", degradedCapabilities: [{ capabilityId: capabilityId("browser"), strength: "required", fallbackCapabilityId: capabilityId("filesystem") }],
    });
  });

  it.each(["optional", "preferred"] as const)("preserves %s degradation through the real resolver", (strength) => {
    const parsed = expectValue(parseAssetDocument(`---
id: skill-binding-${strength}
type: skill
schema-version: 2
tier: core
capability.${strength}: [browser]
capability.features.browser: [read]
---
`));
    const candidate = expectValue(toAssetCandidate(expectValue(validateAsset(parsed)), {
      revision: `revision-skill-binding-${strength}` as AssetRevision,
      source: { layer: "global", sourceId: `fixture-${strength}` },
    }));
    const bindings = expectValue(resolveCapabilityBindings({
      context: context(), catalog: catalog(), bindings: [binding("a", "project-a", "tool-a")], observations: [], permissions: [],
    }));
    const resolved = resolveScope({
      context: { executionMode: "advisory_preparation", workflow: { kind: "none" } }, snapshot: { candidates: [candidate] },
      capabilityContext: bindings.capabilityContext,
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.evaluations[0]?.reason).toMatchObject({
      kind: "included", degradedCapabilities: [{ capabilityId: capabilityId("browser"), strength }],
    });
  });
});
