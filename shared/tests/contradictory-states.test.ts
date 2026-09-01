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
// Schema values are internal; these two are asserted on directly.
import { DegradedInfo } from "../src/status.ts";
import { TransitionCandidateDto } from "../src/workflow.ts";

const resolvedContext = (overrides: {
  cost?: Record<string, unknown>;
  reason?: Record<string, unknown>;
  conflicts?: unknown[];
  body?: string;
}): unknown => ({
  scope: { projectId: "project-1" },
  assets: [
    {
      assetId: "asset-1",
      revision: "revision-1",
      assetType: "skill",
      loadingTier: "core",
      reason: overrides.reason ?? { kind: "included", explanation: "Matched scope" },
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
          reason: { kind: "unavailable", explanation: "Runtime is down", availability: "available" },
        }),
      ),
    ).toThrow();
  });

  it.each(["degraded", "unavailable"])(
    "accepts an unavailable reason reporting %s",
    (availability) => {
      expect(() =>
        parseResolvedContextDto(
          resolvedContext({
            reason: { kind: "unavailable", explanation: "Runtime is down", availability },
          }),
        ),
      ).not.toThrow();
    },
  );

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
      parseResolvedContextDto(resolvedContext({ reason: { kind: "included", explanation: "" } })),
    ).toThrow();
  });

  it("rejects a conflict that involves no asset", () => {
    expect(() =>
      parseResolvedContextDto(
        resolvedContext({ conflicts: [{ explanation: "Overlapping assets", involvedAssetIds: [] }] }),
      ),
    ).toThrow();
  });

  it("accepts a conflict that names the assets it involves", () => {
    expect(() =>
      parseResolvedContextDto(
        resolvedContext({
          conflicts: [{ explanation: "Overlapping assets", involvedAssetIds: ["asset-1"] }],
        }),
      ),
    ).not.toThrow();
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

  it("omits available from the unavailable resolution reason", () => {
    const reason = (schemas().ResolvedContextDto as any).properties.assets.items.properties.reason;
    const unavailableArm = reason.oneOf.find(
      (arm: any) => arm.properties.kind.const === "unavailable",
    );

    expect(unavailableArm.properties.availability.enum).toEqual(["degraded", "unavailable"]);
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
});
