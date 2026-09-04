import { describe, expect, it } from "vitest";
import {
  contractJsonSchemas,
  parseResolveRequest,
  tryParseResolveRequest,
} from "../src/index.ts";

describe("explicit resolution context", () => {
  it("D1: rejects development execution without a workflow", () => {
    const result = tryParseResolveRequest({
      context: {
        executionMode: "development_execution",
        workflow: { kind: "none" },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_request");
  });

  it("D2: accepts advisory selected and development standalone contexts", () => {
    const advisory = parseResolveRequest({
      context: {
        executionMode: "advisory_preparation",
        workflow: { kind: "selected", workflowId: "workflow-1", stageId: "stage-1" },
      },
    });
    const development = parseResolveRequest({
      context: {
        executionMode: "development_execution",
        workflow: { kind: "standalone", skillId: "skill-1" },
      },
    });

    expect(advisory.context.workflow).toEqual({
      kind: "selected",
      workflowId: "workflow-1",
      stageId: "stage-1",
    });
    expect(development.context.workflow).toEqual({ kind: "standalone", skillId: "skill-1" });
  });

  it("emits the development workflow restriction in JSON Schema", () => {
    const schema = contractJsonSchemas().ResolveRequest as any;
    const contextArms = schema.properties.context.oneOf;
    const development = contextArms.find(
      (arm: any) => arm.properties.executionMode.const === "development_execution",
    );

    expect(contextArms).toHaveLength(2);
    for (const arm of contextArms) {
      expect(arm.additionalProperties).toBe(false);
      for (const workflowArm of arm.properties.workflow.oneOf) {
        expect(workflowArm.additionalProperties).toBe(false);
      }
    }
    expect(development.properties.workflow.oneOf).toHaveLength(2);
    expect(development.properties.workflow.oneOf).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ properties: { kind: { const: "none" } } }),
      ]),
    );
  });
});
