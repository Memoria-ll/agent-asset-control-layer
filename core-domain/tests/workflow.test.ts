import { describe, expect, it } from "vitest";
import {
  parseWorkflowStateDto,
  type AgentExecutionId,
  type RoleId,
  type SnapshotId,
  type StageId,
  type TaskTypeId,
} from "@aacl/shared";
import {
  applyWorkflowTransition,
  buildMetadataCatalog,
  initializeWorkflowState,
  parseAssetDocument,
  parseWorkflowDefinitionAsset,
  possibleWorkflowTransitions,
  projectRoleDefinition,
  projectTaskTypeDefinition,
  validateAsset,
  type AssetResult,
  type CatalogRevision,
  type MetadataCatalog,
  type ResolvedWorkflowDefinition,
} from "../src/index.ts";

const unwrap = <T>(result: AssetResult<T>): T => {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.failure.message);
  return result.value;
};

const canonicalAsset = (document: string) => {
  const parsed = unwrap(parseAssetDocument(document));
  return unwrap(validateAsset(parsed));
};

const catalog = (): MetadataCatalog => {
  const role = projectRoleDefinition(canonicalAsset(`---
id: reviewer
type: role
tier: core
metadata.display-name: Reviewer
---
`));
  const taskType = projectTaskTypeDefinition(canonicalAsset(`---
id: drafting
type: task-type
tier: core
metadata.display-name: Drafting
---
`));
  return unwrap(buildMetadataCatalog({
    revision: "sha256:test" as CatalogRevision,
    roles: [unwrap(role)],
    taskTypes: [unwrap(taskType)],
    providers: [],
    runtimes: [],
    models: [],
    roleModelRelations: [],
  }));
};

const fence = "```";

const basicDefinitionBody = {
  entryRoleId: "reviewer",
  entryStageId: "draft",
  terminalStageId: "done",
  stages: [
    {
      stageId: "draft",
      displayName: "Draft",
      description: "Write the draft",
      requiredRoleId: "reviewer",
      requiredTaskTypeId: "drafting",
    },
    {
      stageId: "done",
      displayName: "Done",
      description: "Finish the workflow",
    },
  ],
  transitions: [
    { fromStageId: "draft", toStageId: "done", transitionKind: "advance" },
  ],
};

const workflowAsset = (body: unknown, id = "review-flow") => canonicalAsset(`---
id: ${id}
type: workflow
tier: core
---
${fence}aacl-workflow
${JSON.stringify(body, null, 2)}
${fence}
`);

const definition = (body: unknown = basicDefinitionBody): ResolvedWorkflowDefinition =>
  unwrap(parseWorkflowDefinitionAsset(workflowAsset(body), catalog()));

const stateFor = (value: ResolvedWorkflowDefinition, stateVersion = 7) =>
  parseWorkflowStateDto({
    workflowId: value.workflowId,
    executionInstanceId: "instance-1",
    stateVersion,
    currentStageId: value.entryStageId,
    entryRoleId: value.entryRoleId,
    currentRoleId: value.entryRoleId,
    linkedAgentExecutionIds: ["agent-1"],
    linkedSnapshotIds: ["snapshot-1"],
    updatedAt: "2026-08-31T12:00:00Z",
  });

const detailCodes = <T>(result: AssetResult<T>): readonly string[] => {
  expect(result.ok).toBe(false);
  return result.ok ? [] : (result.failure.details ?? []).map((item) => item.code);
};

describe("workflow definition domain", () => {
  it("resolves an omitted workflowId from the canonical asset id", () => {
    const value = definition();
    expect(value.workflowId).toBe("review-flow");
  });

  it("accepts a matching workflowId and rejects a mismatching one", () => {
    const matching = unwrap(parseWorkflowDefinitionAsset(
      workflowAsset({ ...basicDefinitionBody, workflowId: "review-flow" }),
      catalog(),
    ));
    expect(matching.workflowId).toBe("review-flow");

    const mismatching = parseWorkflowDefinitionAsset(
      workflowAsset({ ...basicDefinitionBody, workflowId: "other-flow" }),
      catalog(),
    );
    expect(detailCodes(mismatching)).toEqual(["workflow_id_mismatch"]);
  });

  it("classifies exact block and JSON failures", () => {
    const noBlock = parseWorkflowDefinitionAsset(
      canonicalAsset(`---
id: review-flow
type: workflow
tier: core
---
body`),
      catalog(),
    );
    expect(detailCodes(noBlock)).toEqual(["missing_workflow_block"]);

    const duplicateBlock = parseWorkflowDefinitionAsset(
      canonicalAsset(`---
id: review-flow
type: workflow
tier: core
---
${fence}aacl-workflow
{}
${fence}
${fence}aacl-workflow
{}
${fence}`),
      catalog(),
    );
    expect(detailCodes(duplicateBlock)).toEqual(["duplicate_workflow_block"]);

    const invalidJson = parseWorkflowDefinitionAsset(
      canonicalAsset(`---
id: review-flow
type: workflow
tier: core
---
${fence}aacl-workflow
not-json
${fence}`),
      catalog(),
    );
    expect(detailCodes(invalidJson)).toEqual(["invalid_json"]);
  });

  it("ignores general fences and reports an unclosed outer fence", () => {
    const insideClosedFence = parseWorkflowDefinitionAsset(
      canonicalAsset(`---
id: review-flow
type: workflow
tier: core
---
${fence}markdown
${fence}aacl-workflow
${JSON.stringify(basicDefinitionBody)}
${fence}
${fence}`),
      catalog(),
    );
    expect(detailCodes(insideClosedFence)).toEqual(["missing_workflow_block"]);

    const insideUnclosedFence = parseWorkflowDefinitionAsset(
      canonicalAsset(`---
id: review-flow
type: workflow
tier: core
---
${fence}markdown
${fence}aacl-workflow
${JSON.stringify(basicDefinitionBody)}`),
      catalog(),
    );
    expect(detailCodes(insideUnclosedFence)).toEqual(["workflow_block_inside_fence"]);

    const indented = parseWorkflowDefinitionAsset(
      canonicalAsset(`---
id: review-flow
type: workflow
tier: core
---
  \`\`\`aacl-workflow
${JSON.stringify(basicDefinitionBody)}
\`\`\``),
      catalog(),
    );
    expect(detailCodes(indented)).toEqual(["missing_workflow_block"]);
  });

  it("rejects shape, catalog, and graph violations", () => {
    const invalidShape = parseWorkflowDefinitionAsset(
      workflowAsset({ ...basicDefinitionBody, stages: [] }),
      catalog(),
    );
    expect(invalidShape.ok).toBe(false);

    const unknownRole = parseWorkflowDefinitionAsset(
      workflowAsset({
        ...basicDefinitionBody,
        entryRoleId: "missing-role",
        stages: basicDefinitionBody.stages.map((stage) =>
          stage.stageId === "draft" ? { ...stage, requiredRoleId: "missing-role" } : stage),
      }),
      catalog(),
    );
    expect(detailCodes(unknownRole)).toContain("unknown_entry_role");

    const unknownStageRole = parseWorkflowDefinitionAsset(
      workflowAsset({
        ...basicDefinitionBody,
        stages: basicDefinitionBody.stages.map((stage) =>
          stage.stageId === "done" ? { ...stage, requiredRoleId: "missing-role" } : stage),
      }),
      catalog(),
    );
    expect(detailCodes(unknownStageRole)).toEqual(["unknown_role"]);

    const unknownTaskType = parseWorkflowDefinitionAsset(
      workflowAsset({
        ...basicDefinitionBody,
        stages: basicDefinitionBody.stages.map((stage) =>
          stage.stageId === "draft" ? { ...stage, requiredTaskTypeId: "missing-task" } : stage),
      }),
      catalog(),
    );
    expect(detailCodes(unknownTaskType)).toEqual(["unknown_task_type"]);

    const missingEntryRole = parseWorkflowDefinitionAsset(
      workflowAsset({
        ...basicDefinitionBody,
        stages: basicDefinitionBody.stages.map((stage) => {
          if (stage.stageId !== "draft") return stage;
          const { requiredRoleId: _requiredRoleId, ...withoutRole } = stage;
          return withoutRole;
        }),
      }),
      catalog(),
    );
    expect(detailCodes(missingEntryRole)).toEqual(["entry_role_mismatch"]);

    const differentEntryRole = parseWorkflowDefinitionAsset(
      workflowAsset({
        ...basicDefinitionBody,
        stages: basicDefinitionBody.stages.map((stage) =>
          stage.stageId === "draft" ? { ...stage, requiredRoleId: "other-role" } : stage),
      }),
      catalog(),
    );
    expect(detailCodes(differentEntryRole)).toEqual(["entry_role_mismatch"]);

    const orphan = parseWorkflowDefinitionAsset(
      workflowAsset({
        ...basicDefinitionBody,
        stages: [...basicDefinitionBody.stages, {
          stageId: "orphan",
          displayName: "Orphan",
          description: "Cannot be reached",
        }],
      }),
      catalog(),
    );
    expect(detailCodes(orphan)).toEqual(["unreachable_stage"]);

    const deadEnd = parseWorkflowDefinitionAsset(
      workflowAsset({
        ...basicDefinitionBody,
        terminalStageId: "done",
        stages: [...basicDefinitionBody.stages, {
          stageId: "dead-end",
          displayName: "Dead end",
          description: "Cannot finish",
        }],
        transitions: [
          ...basicDefinitionBody.transitions,
          { fromStageId: "draft", toStageId: "dead-end", transitionKind: "reject" },
        ],
      }),
      catalog(),
    );
    expect(detailCodes(deadEnd)).toEqual(["unreachable_terminal"]);
  });

  it("permits retry cycles and rejects advance self-loops and bad cycles", () => {
    const retryCycle = {
      ...basicDefinitionBody,
      stages: [...basicDefinitionBody.stages, {
        stageId: "review",
        displayName: "Review",
        description: "Review the draft",
      }],
      transitions: [
        { fromStageId: "draft", toStageId: "review", transitionKind: "advance" },
        { fromStageId: "review", toStageId: "draft", transitionKind: "retry" },
        { fromStageId: "review", toStageId: "done", transitionKind: "advance" },
      ],
    };
    expect(parseWorkflowDefinitionAsset(workflowAsset(retryCycle), catalog()).ok).toBe(true);

    const selfLoop = parseWorkflowDefinitionAsset(workflowAsset({
      ...basicDefinitionBody,
      transitions: [
        ...basicDefinitionBody.transitions,
        { fromStageId: "draft", toStageId: "draft", transitionKind: "advance" },
      ],
    }), catalog());
    expect(detailCodes(selfLoop)).toEqual(["self_loop"]);

    const badCycle = parseWorkflowDefinitionAsset(workflowAsset({
      ...basicDefinitionBody,
      stages: [...basicDefinitionBody.stages, {
        stageId: "review",
        displayName: "Review",
        description: "Review the draft",
      }],
      transitions: [
        { fromStageId: "draft", toStageId: "review", transitionKind: "advance" },
        { fromStageId: "review", toStageId: "draft", transitionKind: "advance" },
        { fromStageId: "review", toStageId: "done", transitionKind: "advance" },
      ],
    }), catalog());
    expect(detailCodes(badCycle)).toEqual(["cycle_without_retry_or_return"]);
  });

  it("initializes state fields from the definition and caller links", () => {
    const value = definition();
    const seed = initializeWorkflowState(value, {
      linkedAgentExecutionIds: ["agent-1" as AgentExecutionId],
      linkedSnapshotIds: ["snapshot-1" as SnapshotId],
    });
    expect(seed).toEqual({
      workflowId: "review-flow",
      currentStageId: "draft",
      entryRoleId: "reviewer",
      currentRoleId: "reviewer",
      linkedAgentExecutionIds: ["agent-1"],
      linkedSnapshotIds: ["snapshot-1"],
    });
  });

  it("evaluates all outgoing transitions in declaration order with complete reasons", () => {
    const value = definition({
      ...basicDefinitionBody,
      stages: [
        basicDefinitionBody.stages[0],
        {
          ...basicDefinitionBody.stages[1],
          requiredRoleId: "reviewer",
          requiredTaskTypeId: "drafting",
          requiredCapabilityRefs: ["cap-stage"],
          requiredArtifactRefs: ["artifact-stage"],
        },
      ],
      transitions: [
        {
          fromStageId: "draft",
          toStageId: "done",
          transitionKind: "advance",
          requiredCapabilityRefs: ["cap-edge", "cap-stage"],
          requiredArtifactRefs: ["artifact-edge", "artifact-stage"],
        },
      ],
    });
    const result = possibleWorkflowTransitions(value, stateFor(value), {
      availableCapabilityRefs: [],
      availableArtifactRefs: [],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]).toMatchObject({
        blocked: true,
        stateVersion: 7,
        requiredRoleId: "reviewer",
        requiredTaskTypeId: "drafting",
        blockedReasons: [
          'Required role "reviewer" is not available.',
          'Required task type "drafting" is not available.',
          'Required capability "cap-stage" is not available.',
          'Required capability "cap-edge" is not available.',
          'Required artifact "artifact-stage" is not available.',
          'Required artifact "artifact-edge" is not available.',
        ],
      });
    }
  });

  it("returns unblocked candidates without blockedReasons and applies only the selection", () => {
    const value = definition({
      ...basicDefinitionBody,
      transitions: [
        ...basicDefinitionBody.transitions,
        { fromStageId: "draft", toStageId: "done", transitionKind: "retry" },
      ],
    });
    const state = stateFor(value);
    const input = {
      roleId: "reviewer" as RoleId,
      taskTypeId: "drafting" as TaskTypeId,
      availableCapabilityRefs: [],
      availableArtifactRefs: [],
    };
    const candidates = possibleWorkflowTransitions(value, state, input);
    expect(candidates.ok).toBe(true);
    if (candidates.ok) {
      expect(candidates.value.map((candidate) => candidate.transitionKind)).toEqual(["advance", "retry"]);
      expect(candidates.value.every((candidate) => !candidate.blocked)).toBe(true);
      expect(candidates.value.every((candidate) => !Object.hasOwn(candidate, "blockedReasons"))).toBe(true);

      const applied = applyWorkflowTransition(value, state, candidates.value[1]!, input);
      expect(applied).toEqual({
        ok: true,
        value: {
          workflowId: "review-flow",
          executionInstanceId: "instance-1",
          stateVersion: 8,
          currentStageId: "done",
          entryRoleId: "reviewer",
          currentRoleId: "reviewer",
          linkedAgentExecutionIds: ["agent-1"],
          linkedSnapshotIds: ["snapshot-1"],
        },
      });
    }
  });

  it("rejects stale, undeclared, blocked, and mismatched state transitions", () => {
    const value = definition({
      ...basicDefinitionBody,
      stages: [
        basicDefinitionBody.stages[0],
        { ...basicDefinitionBody.stages[1], requiredRoleId: "reviewer" },
      ],
    });
    const state = stateFor(value);
    const input = { availableCapabilityRefs: [], availableArtifactRefs: [] };
    const stale = applyWorkflowTransition(value, state, {
      toStageId: "done" as StageId,
      transitionKind: "advance",
      expectedStateVersion: 6,
    }, input);
    expect(detailCodes(stale)).toEqual(["state_version_conflict"]);

    const undeclared = applyWorkflowTransition(value, state, {
      toStageId: "draft" as StageId,
      transitionKind: "return",
      expectedStateVersion: 7,
    }, input);
    expect(detailCodes(undeclared)).toEqual(["transition_not_declared"]);

    const blocked = applyWorkflowTransition(value, state, {
      toStageId: "done" as StageId,
      transitionKind: "advance",
      expectedStateVersion: 7,
    }, { ...input, roleId: "wrong-role" as RoleId });
    expect(detailCodes(blocked)).toEqual(["transition_blocked"]);

    const mismatchedState = parseWorkflowStateDto({
      ...state,
      workflowId: "other-flow",
    });
    const mismatch = possibleWorkflowTransitions(value, mismatchedState, input);
    expect(detailCodes(mismatch)).toEqual(["state_definition_mismatch"]);
  });
});
