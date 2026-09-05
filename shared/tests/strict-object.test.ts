import { describe, expect, it } from "vitest";
// The .js suffix is required for NodeNext resolution of the TypeScript source.
import type {
  IdeContextInput,
  ResolutionContextInput,
  WorkflowBindingInput,
} from "../src/index.ts";
import {
  parseAgentExecutionDto,
  parseResolveRequest,
  parseExecutionAuthorizationRequest,
  parseExecutionAuthorizationResult,
  parseWorkflowStartCommitRequest,
  tryParseResolveRequest,
} from "../src/index.ts";

describe("strict boundary objects", () => {
  it("rejects unknown fields at runtime", () => {
    const input = {
      context: { executionMode: "advisory_preparation", workflow: { kind: "none" } },
      zzz: true,
    };

    expect(() => parseResolveRequest(input)).toThrow();

    const result = tryParseResolveRequest(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe("invalid_request");
    expect(result.error.details).toEqual([
      expect.objectContaining({
        path: ["zzz"],
        code: "unrecognized_keys",
      }),
    ]);
  });

  it("requires workflow start provenance only for workflow_start", () => {
    expect(() => parseExecutionAuthorizationRequest({
      operation: "workflow_start",
      context: { executionMode: "advisory_preparation", workflow: { kind: "none" } },
    })).toThrow();
    expect(() => parseExecutionAuthorizationRequest({
      operation: "research",
      context: { executionMode: "advisory_preparation", workflow: { kind: "none" } },
      workflowStart: {
        startFrom: { kind: "advisory_none" },
        target: { workflowId: "workflow-1", workflowRevision: "sha256:workflow-1" },
      },
    })).toThrow();
  });

  it("keeps authorization denial reasons aligned with their guidance", () => {
    expect(() => parseExecutionAuthorizationResult({
      decision: "denied",
      operation: "implementation",
      reason: "workflow_selection_required",
      guidance: { kind: "use_advisory_mode", requiredMode: "advisory_preparation" },
    })).toThrow();
    expect(() => parseExecutionAuthorizationResult({
      decision: "denied",
      operation: "research",
      reason: "workflow_already_selected",
      guidance: { kind: "continue_selected_workflow", nextOperation: "implementation" },
    })).toThrow();
  });

  it("rejects workflow-start bundles with inconsistent execution links", () => {
    const bundle = {
      operation: "workflow_start",
      idempotencyKey: "start-1",
      precondition: {
        context: { executionMode: "advisory_preparation", workflow: { kind: "none" } },
        target: { workflowId: "workflow-1", workflowRevision: "revision-1" },
      },
      nextContext: { executionMode: "development_execution", roleId: "role-1", workflow: { kind: "selected", workflowId: "workflow-1", workflowRevision: "revision-1", stageId: "stage-1" } },
      agentExecution: {
        agentExecutionId: "agent-1",
        executionMode: "development_execution",
        workflowBinding: { kind: "workflow", workflowId: "workflow-1", workflowRevision: "revision-1", executionInstanceId: "instance-1" },
        stageId: "stage-1",
        roleId: "role-1",
        startedAt: "2026-09-05T10:00:00Z",
      },
      workflowState: {
        workflowId: "workflow-1",
        workflowRevision: "revision-1",
        executionInstanceId: "instance-1",
        stateVersion: 0,
        currentStageId: "stage-1",
        entryRoleId: "role-1",
        currentRoleId: "role-1",
        linkedAgentExecutionIds: ["agent-1"],
        linkedSnapshotIds: [],
        updatedAt: "2026-09-05T10:00:00Z",
      },
    };

    expect(parseWorkflowStartCommitRequest(bundle)).toEqual(bundle);
    expect(() => parseWorkflowStartCommitRequest({
      ...bundle,
      workflowState: { ...bundle.workflowState, executionInstanceId: "instance-2" },
    })).toThrow();
    expect(() => parseWorkflowStartCommitRequest({
      ...bundle,
      workflowState: { ...bundle.workflowState, linkedAgentExecutionIds: [] },
    })).toThrow();
    expect(() => parseWorkflowStartCommitRequest({
      ...bundle,
      agentExecution: { ...bundle.agentExecution, providerId: "anthropic" },
    })).toThrow();
    expect(() => parseWorkflowStartCommitRequest({
      ...bundle,
      workflowState: { ...bundle.workflowState, currentRoleId: "role-2" },
    })).toThrow();
  });
});

/**
 * A caller composes these from plain strings. Identifier brands exist only on
 * the parsed side, so an `*Input` alias derived from `z.infer` would be
 * unsatisfiable for a consumer that holds no schema and no zod. This is a
 * compile-time assertion: it fails `tsc`, not the runner.
 */
const composedContext: ResolutionContextInput = {
  executionMode: "advisory_preparation",
  workflow: { kind: "none" },
  projectId: "project-1",
  directory: "/workspace",
};

// The nested binding input is composed from plain strings without importing the schema value.
const composedWorkflowBinding: WorkflowBindingInput = {
  kind: "workflow",
  workflowId: "workflow-1",
  workflowRevision: "sha256:workflow-1",
  executionInstanceId: "instance-1",
};

const composedIdeContext: IdeContextInput = {
  workspaceFolder: "/workspace",
  selectedFilePaths: ["/workspace/readme.md"],
};

describe("input aliases are composable from plain strings", () => {
  it("accepts the composed values through the real parser", () => {
    const request = parseResolveRequest({
      context: composedContext,
      ide: composedIdeContext,
    });

    expect(request.context.projectId).toBe("project-1");
    expect(request.ide?.workspaceFolder).toBe("/workspace");

    const execution = parseAgentExecutionDto({
      agentExecutionId: "execution-1",
      workflowBinding: composedWorkflowBinding,
      executionMode: "development_execution",
      startedAt: "2026-08-30T01:02:03+09:00",
    });
    expect(execution.workflowBinding).toEqual(composedWorkflowBinding);
  });
});
