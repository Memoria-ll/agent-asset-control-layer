import { describe, expect, it } from "vitest";
// The .js suffix is required for NodeNext resolution of the TypeScript source.
import type {
  IdeContextInput,
  ResolutionScopeInput,
  WorkflowBindingInput,
} from "../src/index.ts";
import {
  parseAgentExecutionDto,
  parseResolveRequest,
  tryParseResolveRequest,
} from "../src/index.ts";

describe("strict boundary objects", () => {
  it("rejects unknown fields at runtime", () => {
    const input = { scope: {}, zzz: true };

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
});

/**
 * A caller composes these from plain strings. Identifier brands exist only on
 * the parsed side, so an `*Input` alias derived from `z.infer` would be
 * unsatisfiable for a consumer that holds no schema and no zod. This is a
 * compile-time assertion: it fails `tsc`, not the runner.
 */
const composedScope: ResolutionScopeInput = {
  projectId: "project-1",
  directory: "/workspace",
};

// The nested binding input is composed from plain strings without importing the schema value.
const composedWorkflowBinding: WorkflowBindingInput = {
  kind: "workflow",
  workflowId: "workflow-1",
  executionInstanceId: "instance-1",
};

const composedIdeContext: IdeContextInput = {
  workspaceFolder: "/workspace",
  selectedFilePaths: ["/workspace/readme.md"],
};

describe("input aliases are composable from plain strings", () => {
  it("accepts the composed values through the real parser", () => {
    const request = parseResolveRequest({
      scope: composedScope,
      ide: composedIdeContext,
    });

    expect(request.scope.projectId).toBe("project-1");
    expect(request.ide?.workspaceFolder).toBe("/workspace");

    const execution = parseAgentExecutionDto({
      agentExecutionId: "execution-1",
      workflowBinding: composedWorkflowBinding,
      startedAt: "2026-08-30T01:02:03+09:00",
    });
    expect(execution.workflowBinding).toEqual(composedWorkflowBinding);
  });
});
