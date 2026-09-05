import { describe, expect, it } from "vitest";
import { parseResolveRequest } from "@aacl/shared";
import { toResolutionContext, toValidatedResolutionContext } from "../src/index.ts";

type ContextInput = Parameters<typeof toResolutionContext>[0];

const firstFailure = (input: unknown): { readonly path: readonly string[]; readonly code: string } => {
  const result = toValidatedResolutionContext(input as ContextInput);
  if (result.ok) throw new Error("Expected the resolution context to be rejected.");
  expect(result.failure.code).toBe("invalid_request");
  const detail = result.failure.details?.[0];
  if (detail === undefined) throw new Error("Expected a failure detail.");
  return detail;
};

describe("resolution context", () => {
  it("keeps agent execution out of the resolution scope", () => {
    const request = parseResolveRequest({
      context: {
        executionMode: "advisory_preparation",
        workflow: { kind: "none" },
        roleId: "reviewer",
        modelId: "claude-opus-5",
      },
    });
    const result = toResolutionContext(request.context);

    expect(result).toEqual({
      ok: true,
      value: { roleId: "reviewer", modelId: "claude-opus-5" },
    });
    if (result.ok) {
      expect(Object.keys(result.value)).toEqual(["roleId", "modelId"]);
      expect("agentExecutionId" in result.value).toBe(false);
    }

    const contextWithExecution = {
      executionMode: "advisory_preparation" as const,
      workflow: { kind: "none" as const },
      roleId: "reviewer",
      agentExecutionId: "exec-1",
    } as Parameters<typeof toResolutionContext>[0];
    const invalid = toResolutionContext(contextWithExecution);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.failure.details?.[0]?.code).toBe("unknown_key");
    }
    expect(() => parseResolveRequest({ context: contextWithExecution })).toThrow();
  });

  it("projects a selected workflow into the internal matching axes", () => {
    const request = parseResolveRequest({
      context: {
        executionMode: "advisory_preparation",
        workflow: { kind: "selected", workflowId: "review-flow", workflowRevision: "sha256:workflow", stageId: "review" },
      },
    });

    expect(toResolutionContext(request.context)).toEqual({
      ok: true,
      value: { workflowId: "review-flow", stageId: "review" },
    });
  });

  it("rejects an empty resolution identifier", () => {
    const result = toResolutionContext({
      executionMode: "advisory_preparation",
      workflow: { kind: "none" },
      roleId: "",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("invalid_request");
      expect(result.failure.details?.[0]?.code).toBe("empty_identifier");
    }
  });

  it("normalizes trailing slashes on a directory scope", () => {
    const result = toResolutionContext({
      executionMode: "advisory_preparation",
      workflow: { kind: "none" },
      directory: "/repo/src/",
    });

    expect(result).toEqual({ ok: true, value: { directory: "/repo/src" } });
  });

  it.each(["\\repo\\src", "C:/repo", "repo/src", "/repo/./src", "/repo/../src"])(
    "rejects an invalid directory scope %s",
    (directory) => {
      const result = toResolutionContext({
        executionMode: "advisory_preparation",
        workflow: { kind: "none" },
        directory,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.code).toBe("invalid_request");
        expect(result.failure.details?.[0]?.code).toBe("invalid_directory");
      }
    },
  );
});

describe("execution context validation", () => {
  it("rejects development execution without a workflow selection", () => {
    expect(firstFailure({
      executionMode: "development_execution",
      workflow: { kind: "none" },
    })).toEqual({
      path: ["context", "workflow", "kind"],
      code: "workflow_selection_required",
      message: expect.any(String),
    });
  });

  it.each([
    ["a missing execution mode", { workflow: { kind: "none" } }, ["context", "executionMode"], "invalid_value"],
    ["an unknown execution mode", { executionMode: "batch", workflow: { kind: "none" } }, ["context", "executionMode"], "invalid_value"],
    ["a missing workflow selection", { executionMode: "advisory_preparation" }, ["context", "workflow"], "invalid_value"],
    ["an unknown workflow kind", { executionMode: "advisory_preparation", workflow: { kind: "resumed" } }, ["context", "workflow", "kind"], "invalid_value"],
    ["a non-string selected workflow id", { executionMode: "advisory_preparation", workflow: { kind: "selected", workflowId: 42, workflowRevision: "sha256:workflow", stageId: "review" } }, ["context", "workflow", "workflowId"], "invalid_value"],
    ["an empty selected stage id", { executionMode: "advisory_preparation", workflow: { kind: "selected", workflowId: "review-flow", workflowRevision: "sha256:workflow", stageId: "" } }, ["context", "workflow", "stageId"], "empty_identifier"],
    ["a standalone selection without a skill", { executionMode: "advisory_preparation", workflow: { kind: "standalone" } }, ["context", "workflow", "skillId"], "invalid_value"],
    ["an unknown workflow selection key", { executionMode: "advisory_preparation", workflow: { kind: "none", stageId: "review" } }, ["context", "workflow", "stageId"], "unknown_key"],
    // The union carries these inside `workflow`, so a top-level pair is a shape
    // the published contract rejects.
    ["a top-level workflow id", { executionMode: "advisory_preparation", workflow: { kind: "none" }, workflowId: "review-flow" }, ["context", "workflowId"], "unknown_key"],
  ])("rejects %s", (_name, input, path, code) => {
    expect(firstFailure(input)).toEqual({ path, code, message: expect.any(String) });
  });

  it("keeps the explicit execution state next to the projected matching axes", () => {
    const result = toValidatedResolutionContext({
      executionMode: "development_execution",
      workflow: { kind: "standalone", skillId: "skill-review" },
      roleId: "reviewer",
      // A trailing slash separates the two: the scope is normalized for
      // matching, the echoed context is what the caller sent.
      directory: "/repo/src/",
    });

    expect(result).toEqual({
      ok: true,
      value: {
        execution: {
          executionMode: "development_execution",
          workflow: { kind: "standalone", skillId: "skill-review" },
          roleId: "reviewer",
          directory: "/repo/src/",
        },
        scope: { roleId: "reviewer", directory: "/repo/src" },
      },
    });
  });

  it("carries a selected workflow into both the execution state and the scope", () => {
    const request = parseResolveRequest({
      context: {
        executionMode: "development_execution",
        workflow: { kind: "selected", workflowId: "review-flow", workflowRevision: "sha256:workflow", stageId: "review" },
      },
    });
    const result = toValidatedResolutionContext(request.context);

    expect(result).toEqual({
      ok: true,
      value: {
        execution: request.context,
        scope: { workflowId: "review-flow", stageId: "review" },
      },
    });
  });
});
