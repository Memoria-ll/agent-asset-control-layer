import * as z from "zod/mini";
import { describe, expect, it } from "vitest";
import {
  contractJsonSchemas,
  parseAgentExecutionDto,
  parseResolvedContextDto,
  parseTransitionCandidateDto,
  parseWorkflowDefinitionDto,
  parseWorkflowStateDto,
} from "../src/index.ts";
// Schema values and the graph bounds are internal to the package; asserted on directly here.
import { DegradedInfo } from "../src/status.ts";
import { TransitionCandidateDto, WORKFLOW_STAGE_LIMIT, WORKFLOW_TRANSITION_LIMIT } from "../src/workflow.ts";

const resolvedContext = (overrides: {
  cost?: Record<string, unknown>;
  reason?: Record<string, unknown>;
  conflicts?: unknown[];
  body?: string;
}): unknown => ({
  context: {
    executionMode: "advisory_preparation",
    workflow: { kind: "none" },
    projectId: "project-1",
  },
  assets: [
    {
      assetId: "asset-1",
      revision: "revision-1",
      assetType: "skill",
      loadingTier: "core",
      reason: overrides.reason ?? { kind: "included", explanation: "Matched scope", matchedAxes: [] },
      ...(overrides.body === undefined ? {} : { body: overrides.body }),
    },
  ],
  conflicts: overrides.conflicts ?? [],
  cost: overrides.cost ?? {
    totalTokenEstimate: 0,
    includedAssetCount: 1,
    excludedAssetCount: 0,
  },
  resolvedAt: "2026-08-30T01:02:03+09:00",
});

describe("boundary states that cannot exist", () => {
  it("accepts a workflow-bound execution with both identifiers", () => {
    const parsed = parseAgentExecutionDto({
      agentExecutionId: "execution-1",
      workflowBinding: {
        kind: "workflow",
        workflowId: "workflow-1",
        executionInstanceId: "instance-1",
      },
      startedAt: "2026-08-30T01:02:03+09:00",
    });

    expect(parsed.workflowBinding).toEqual({
      kind: "workflow",
      workflowId: "workflow-1",
      executionInstanceId: "instance-1",
    });
  });

  it("accepts a standalone execution binding", () => {
    const parsed = parseAgentExecutionDto({
      agentExecutionId: "execution-1",
      workflowBinding: { kind: "standalone" },
      startedAt: "2026-08-30T01:02:03+09:00",
    });

    expect(parsed.workflowBinding).toEqual({ kind: "standalone" });
  });

  it("requires a workflow binding on an agent execution", () => {
    expect(() =>
      parseAgentExecutionDto({
        agentExecutionId: "execution-1",
        startedAt: "2026-08-30T01:02:03+09:00",
      }),
    ).toThrow();
  });

  it("rejects a legacy top-level workflow identifier", () => {
    expect(() =>
      parseAgentExecutionDto({
        agentExecutionId: "execution-1",
        workflowId: "workflow-1",
        startedAt: "2026-08-30T01:02:03+09:00",
      }),
    ).toThrow();
  });

  it("requires an execution instance identifier on workflow state", () => {
    expect(() =>
      parseWorkflowStateDto({
        workflowId: "workflow-1",
        stateVersion: 0,
        currentStageId: "stage-1",
        entryRoleId: "role-1",
        currentRoleId: "role-1",
        linkedAgentExecutionIds: [],
        linkedSnapshotIds: [],
        updatedAt: "2026-08-30T01:02:03+09:00",
      }),
    ).toThrow();
  });

  it("accepts a well-formed resolved context", () => {
    expect(parseResolvedContextDto(resolvedContext({})).cost.includedAssetCount).toBe(1);
  });

  it.each([
    ["includedAssetCount", { totalTokenEstimate: 0, includedAssetCount: -1, excludedAssetCount: 0 }],
    ["excludedAssetCount", { totalTokenEstimate: 0, includedAssetCount: 0, excludedAssetCount: -1 }],
  ])("rejects a negative %s", (_name, cost) => {
    expect(() => parseResolvedContextDto(resolvedContext({ cost }))).toThrow();
  });

  it("rejects an unavailable reason that also claims availability", () => {
    expect(() =>
      parseResolvedContextDto(
        resolvedContext({
          reason: {
            kind: "unavailable",
            explanation: "Runtime is down",
            availability: "available",
            detail: { cause: "missing_requirement", failedRequirements: ["asset-required"] },
          },
        }),
      ),
    ).toThrow();
  });

  it("accepts an unavailable reason", () => {
    expect(() =>
      parseResolvedContextDto(
        resolvedContext({
          reason: {
            kind: "unavailable",
            explanation: "Runtime is down",
            availability: "unavailable",
            detail: { cause: "missing_requirement", failedRequirements: ["asset-required"] },
          },
        }),
      ),
    ).not.toThrow();
  });

  it("rejects a degraded state carrying no reason", () => {
    expect(z.safeParse(DegradedInfo, { reasons: [] }).success).toBe(false);
    expect(z.safeParse(DegradedInfo, { reasons: ["Runtime is down"] }).success).toBe(true);
  });

  // A length bound on the list still admits a list of blanks, which leaves the
  // consumer exactly as unable to explain the state as an empty list did.
  it("rejects a blank reason inside an otherwise well-formed list", () => {
    expect(z.safeParse(DegradedInfo, { reasons: [""] }).success).toBe(false);
    expect(() =>
      parseTransitionCandidateDto({
        toStageId: "stage-2",
        transitionKind: "advance",
        stateVersion: 0,
        blocked: true,
        blockedReasons: [""],
      }),
    ).toThrow();
  });

  it("rejects a blank explanation on a resolution reason", () => {
    expect(() =>
      parseResolvedContextDto(resolvedContext({ reason: { kind: "included", explanation: "", matchedAxes: [] } })),
    ).toThrow();
  });

  it("rejects a conflict that involves no asset", () => {
    expect(() =>
      parseResolvedContextDto(
        resolvedContext({ conflicts: [{ kind: "mandatory_conflict", explanation: "Overlapping assets", involvedAssetIds: [] }] }),
      ),
    ).toThrow();
  });

  it("accepts a conflict that names the assets it involves", () => {
    expect(() =>
      parseResolvedContextDto(
        resolvedContext({
          conflicts: [{ kind: "mandatory_conflict", explanation: "Overlapping assets", involvedAssetIds: ["asset-1"] }],
        }),
      ),
    ).not.toThrow();
  });

  it.each([
    ["an excluded candidate whose invalid directory has no diagnostic", {
      kind: "excluded",
      explanation: "The candidate has an invalid directory selector.",
      detail: { cause: "invalid_directory", diagnostics: [] },
    }],
    ["an unavailable candidate that names no failed requirement", {
      kind: "unavailable",
      explanation: "A requirement failed.",
      availability: "unavailable",
      detail: { cause: "missing_requirement", failedRequirements: [] },
    }],
    ["an unavailable candidate that names no denied capability", {
      kind: "unavailable",
      explanation: "A capability is not permitted.",
      availability: "unavailable",
      detail: { cause: "capability_not_allowed", failedCapabilities: [] },
    }],
    ["a capability failure whose requirement list is present but empty", {
      kind: "unavailable",
      explanation: "A capability is not permitted.",
      availability: "unavailable",
      detail: { cause: "capability_not_allowed", failedCapabilities: ["cap-a"], failedRequirements: [] },
    }],
    // A required dependency with no usable fallback is a hard failure, so a
    // required degradation naming none describes a state the resolver cannot
    // reach and a consumer cannot explain.
    ["a required capability degradation with no fallback", {
      kind: "included",
      explanation: "Matched scope",
      matchedAxes: [],
      degradedCapabilities: [{ capabilityId: "cap-a", strength: "required" }],
    }],
    // Absence already carries "nothing degraded", so the empty list is a second
    // spelling of it rather than a state of its own.
    ["an included reason carrying an empty degradation list", {
      kind: "included",
      explanation: "Matched scope",
      matchedAxes: [],
      degradedCapabilities: [],
    }],
  ])("rejects %s", (_name, reason) => {
    expect(() => parseResolvedContextDto(resolvedContext({ reason }))).toThrow();
  });

  it("accepts a required capability degradation that names its fallback", () => {
    const parsed = parseResolvedContextDto(resolvedContext({
      reason: {
        kind: "included",
        explanation: "Matched scope",
        matchedAxes: [],
        degradedCapabilities: [{ capabilityId: "cap-a", strength: "required", fallbackCapabilityId: "cap-b" }],
      },
    }));

    expect(parsed.assets[0]?.reason).toMatchObject({
      degradedCapabilities: [{ capabilityId: "cap-a", strength: "required", fallbackCapabilityId: "cap-b" }],
    });
  });

  it("keeps a soft capability degradation representable without a fallback", () => {
    const parsed = parseResolvedContextDto(resolvedContext({
      reason: {
        kind: "included",
        explanation: "Matched scope",
        matchedAxes: [],
        degradedCapabilities: [{ capabilityId: "cap-a", strength: "preferred" }],
      },
    }));

    expect(parsed.assets[0]?.reason).toMatchObject({
      degradedCapabilities: [{ capabilityId: "cap-a", strength: "preferred" }],
    });
  });

  it("keeps an empty matched-axis list representable", () => {
    // A globally scoped asset matches no axis, so this array is a real state
    // rather than the missing-evidence shape the rejections above cover.
    const parsed = parseResolvedContextDto(resolvedContext({
      reason: { kind: "included", explanation: "Matched scope", matchedAxes: [] },
    }));

    expect(parsed.assets[0]?.reason).toMatchObject({ matchedAxes: [] });
  });

  it("keeps an empty asset body representable", () => {
    const parsed = parseResolvedContextDto(resolvedContext({ body: "" }));

    expect(parsed.assets[0]?.body).toBe("");
  });

  it("rejects a blocked transition with no reason", () => {
    expect(() =>
      parseTransitionCandidateDto({
        toStageId: "stage-2",
        transitionKind: "advance",
        stateVersion: 0,
        blocked: true,
        blockedReasons: [],
      }),
    ).toThrow();
  });

  it("rejects an unblocked transition carrying blocking reasons", () => {
    expect(() =>
      parseTransitionCandidateDto({
        toStageId: "stage-2",
        transitionKind: "advance",
        stateVersion: 0,
        blocked: false,
        blockedReasons: ["Role mismatch"],
      }),
    ).toThrow();
  });

  it("round-trips both transition arms through JSON", () => {
    for (const input of [
      { toStageId: "stage-2", transitionKind: "advance", stateVersion: 7, blocked: false },
      {
        toStageId: "stage-2",
        transitionKind: "retry",
        stateVersion: 7,
        blocked: true,
        blockedReasons: ["Role mismatch"],
      },
    ]) {
      const parsed = parseTransitionCandidateDto(input);
      expect(z.parse(TransitionCandidateDto, JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    }
  });

  it("rejects a negative workflow state version", () => {
    expect(() =>
      parseWorkflowStateDto({
        workflowId: "workflow-1",
        stateVersion: -1,
        executionInstanceId: "instance-1",
        currentStageId: "stage-1",
        entryRoleId: "role-1",
        currentRoleId: "role-1",
        linkedAgentExecutionIds: [],
        linkedSnapshotIds: [],
        updatedAt: "2026-08-30T01:02:03+09:00",
      }),
    ).toThrow();
  });

  it("rejects an invalid transition kind", () => {
    expect(() =>
      parseTransitionCandidateDto({
        toStageId: "stage-2",
        transitionKind: "fallback",
        stateVersion: 0,
        blocked: false,
      }),
    ).toThrow();
  });

  it("rejects malformed workflow definition shape", () => {
    const definition = {
      entryRoleId: "role-1",
      entryStageId: "stage-1",
      terminalStageId: "stage-1",
      stages: [
        {
          stageId: "stage-1",
          displayName: "Initial stage",
          description: "The initial workflow stage.",
        },
      ],
      transitions: [],
    };

    expect(() => parseWorkflowDefinitionDto({ ...definition, unknown: true })).toThrow();
    expect(() => parseWorkflowDefinitionDto({ ...definition, stages: [] })).toThrow();
    expect(() =>
      parseWorkflowDefinitionDto({
        ...definition,
        stages: [
          {
            stageId: "stage-1",
            displayName: "Initial stage",
            description: "The initial workflow stage.",
            requiredArtifactRefs: [],
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseWorkflowDefinitionDto({
        ...definition,
        stages: [
          {
            stageId: "stage-1",
            displayName: "Initial stage",
            description: "The initial workflow stage.",
            requiredArtifactRefs: ["report", "report"],
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseWorkflowDefinitionDto({
        ...definition,
        transitions: [
          {
            fromStageId: "stage-1",
            toStageId: "stage-1",
            transitionKind: "retry",
            requiredCapabilityRefs: ["review", "review"],
          },
        ],
      }),
    ).toThrow();
  });
});

describe("published JSON Schema carries the same constraints", () => {
  // A cross-field `z.refine` would satisfy the parser assertions above while
  // emitting nothing here, leaving a schema-driven consumer accepting the
  // contradictory values. These assertions are what separate the two.
  const schemas = () => contractJsonSchemas();

  it("states the nonnegative bound on both context counts", () => {
    const cost = (schemas().ResolvedContextDto as any).properties.cost.properties;

    expect(cost.includedAssetCount.minimum).toBe(0);
    expect(cost.excludedAssetCount.minimum).toBe(0);
  });

  it("states the minimum evidence on every negative-state array", () => {
    const reason = (schemas().ResolvedContextDto as any).properties.assets.items.properties.reason;
    const armsFor = (kind: string) => reason.oneOf
      .find((arm: any) => arm.properties.kind.const === kind)
      .properties.detail.oneOf;
    const invalidDirectory = armsFor("excluded")
      .find((arm: any) => arm.properties.cause.const === "invalid_directory");
    const [requirementArm, capabilityArm] = armsFor("unavailable");

    expect(invalidDirectory.properties.diagnostics.minItems).toBe(1);
    expect(requirementArm.properties.failedRequirements.minItems).toBe(1);
    expect(capabilityArm.properties.failedCapabilities.minItems).toBe(1);
    expect(capabilityArm.properties.failedRequirements.minItems).toBe(1);
  });

  it("states the minimum on every optional array of the resolution contract", () => {
    // Optional arrays mean "absent = none", so a present-but-empty one is a
    // second spelling of absence. The required arrays are listed alongside so
    // that a new optional array added here is a deliberate decision.
    const s = schemas() as any;
    const reason = s.ResolvedContextDto.properties.assets.items.properties.reason;
    const included = reason.oneOf.find((arm: any) => arm.properties.kind.const === "included");

    expect(included.properties.degradedCapabilities.minItems).toBe(1);
    expect(included.properties.degradedInfo.properties.reasons.minItems).toBe(1);
    expect(s.ResolveRequest.properties.loadingTiers.minItems).toBe(1);
    expect(s.ResolveRequest.properties.ide.properties.selectedFilePaths.minItems).toBe(1);
    expect(s.CoreErrorDto.properties.details.minItems).toBe(1);
    // Empty is a real state here, so neither carries a minimum.
    expect(included.properties.matchedAxes.minItems).toBeUndefined();
    expect(s.ResolvedContextDto.properties.assets.minItems).toBeUndefined();
    expect(s.ResolvedContextDto.properties.conflicts.minItems).toBeUndefined();
  });

  it("requires a fallback on the required capability-degradation arm only", () => {
    const reason = (schemas().ResolvedContextDto as any).properties.assets.items.properties.reason;
    const arms = reason.oneOf
      .find((arm: any) => arm.properties.kind.const === "included")
      .properties.degradedCapabilities.items.oneOf;
    const required = arms.find((arm: any) => arm.properties.strength.const === "required");
    const soft = arms.find((arm: any) => arm.properties.strength.const === undefined);

    expect(required.required).toContain("fallbackCapabilityId");
    expect(soft.required).not.toContain("fallbackCapabilityId");
  });

  it("fixes unavailable resolution reasons to unavailable", () => {
    const reason = (schemas().ResolvedContextDto as any).properties.assets.items.properties.reason;
    const unavailableArm = reason.oneOf.find(
      (arm: any) => arm.properties.kind.const === "unavailable",
    );

    expect(unavailableArm.properties.availability.const).toBe("unavailable");
  });

  it("requires a reason on the blocked transition arm only", () => {
    const arms = (schemas().TransitionCandidateDto as any).oneOf;
    const blocked = arms.find((arm: any) => arm.properties.blocked.const === true);
    const unblocked = arms.find((arm: any) => arm.properties.blocked.const === false);

    expect(blocked.properties.blockedReasons.minItems).toBe(1);
    expect(blocked.required).toContain("blockedReasons");
    expect(unblocked.properties.blockedReasons).toBeUndefined();
  });

  it("publishes strict nested workflow binding arms", () => {
    const binding = (schemas().AgentExecutionDto as any).properties.workflowBinding;
    const workflow = binding.oneOf.find((arm: any) => arm.properties.kind.const === "workflow");
    const standalone = binding.oneOf.find((arm: any) => arm.properties.kind.const === "standalone");

    expect(binding.oneOf).toHaveLength(2);
    expect(workflow.additionalProperties).toBe(false);
    expect(workflow.required).toEqual(["kind", "workflowId", "executionInstanceId"]);
    expect(standalone.additionalProperties).toBe(false);
    expect(standalone.required).toEqual(["kind"]);
    expect(standalone.properties.workflowId).toBeUndefined();
    expect(standalone.properties.executionInstanceId).toBeUndefined();
  });

  it("states uniqueness on every requirement reference list", () => {
    const definition = schemas().WorkflowDefinitionDto as any;
    const stage = definition.properties.stages.items.properties;
    const transition = definition.properties.transitions.items.properties;

    for (const refs of [
      stage.requiredArtifactRefs,
      stage.requiredCapabilityRefs,
      transition.requiredArtifactRefs,
      transition.requiredCapabilityRefs,
    ]) {
      expect(refs.uniqueItems).toBe(true);
      expect(refs.minItems).toBe(1);
    }
  });

  // The bounds are asserted as literals rather than against the exported constants: comparing
  // the schema to the constant passes when both are absent, which is the case this pins.
  it("states the workflow graph bounds", () => {
    const definition = schemas().WorkflowDefinitionDto as any;

    expect(WORKFLOW_STAGE_LIMIT).toBe(1000);
    expect(WORKFLOW_TRANSITION_LIMIT).toBe(4000);
    expect(definition.properties.stages.minItems).toBe(1);
    expect(definition.properties.stages.maxItems).toBe(1000);
    expect(definition.properties.transitions.maxItems).toBe(4000);
  });
});
