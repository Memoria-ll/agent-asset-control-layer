import * as z from "zod/mini";
import { describe, expect, it } from "vitest";
import { contractJsonSchemas } from "../src/index.ts";
// The registry is internal to the package; only its JSON form is published.
import { contractSchemas } from "../src/json-schema.ts";

const JSON_SCHEMA_DRAFT = "https://json-schema.org/draft/2020-12/schema";

/**
 * The object nodes a rendered schema forbids unknown keys on.
 *
 * A union renders as `oneOf` and carries `additionalProperties` on each arm
 * rather than at the root, so reading only the root would silently stop checking
 * the constraint the moment a DTO becomes a union.
 */
const strictObjectNodes = (
  rendered: Record<string, unknown>,
): Record<string, unknown>[] =>
  Array.isArray(rendered.oneOf)
    ? (rendered.oneOf as Record<string, unknown>[])
    : [rendered];

describe("contract JSON Schemas", () => {
  it("renders every registered schema without unsupported types", () => {
    const renderedSchemas = contractJsonSchemas();

    for (const [name, schema] of Object.entries(contractSchemas)) {
      const rendered = renderedSchemas[name] as Record<string, unknown>;
      const nodes = strictObjectNodes(rendered);

      expect(rendered.$schema, name).toBe(JSON_SCHEMA_DRAFT);
      expect(nodes.length, name).toBeGreaterThan(0);
      for (const [index, node] of nodes.entries()) {
        expect(node.additionalProperties, `${name}[${index}]`).toBe(false);
      }
      expect(() => z.toJSONSchema(schema)).not.toThrow();
    }
  });

  it("keeps input and output JSON Schema representations identical", () => {
    for (const [name, schema] of Object.entries(contractSchemas)) {
      expect(
        z.toJSONSchema(schema, { io: "input" }),
        name,
      ).toEqual(z.toJSONSchema(schema, { io: "output" }));
    }
  });

  it("publishes the workflow definition and nested object constraints", () => {
    const definition = contractJsonSchemas().WorkflowDefinitionDto as any;
    const stage = definition.properties.stages.items;
    const transition = definition.properties.transitions.items;

    expect(definition.additionalProperties).toBe(false);
    expect(definition.required).toEqual([
      "entryRoleId",
      "entryStageId",
      "terminalStageId",
      "stages",
      "transitions",
    ]);
    expect(definition.properties.workflowId).toBeDefined();
    expect(stage.additionalProperties).toBe(false);
    expect(stage.required).toEqual(["stageId", "displayName", "description"]);
    expect(stage.properties.requiredArtifactRefs.minItems).toBe(1);
    expect(stage.properties.requiredCapabilityRefs.minItems).toBe(1);
    expect(transition.additionalProperties).toBe(false);
    expect(transition.required).toEqual(["fromStageId", "toStageId", "transitionKind"]);
    expect(transition.properties.transitionKind.enum).toEqual([
      "advance",
      "retry",
      "reject",
      "return",
    ]);
    expect(transition.properties.requiredArtifactRefs.minItems).toBe(1);
    expect(transition.properties.requiredCapabilityRefs.minItems).toBe(1);
  });

  it("publishes workflow state and candidate required keys", () => {
    const schemas = contractJsonSchemas() as any;
    expect(schemas.WorkflowStateDto.required).toEqual([
      "workflowId",
      "workflowRevision",
      "executionInstanceId",
      "stateVersion",
      "currentStageId",
      "entryRoleId",
      "currentRoleId",
      "linkedAgentExecutionIds",
      "linkedSnapshotIds",
      "updatedAt",
    ]);
    expect(schemas.WorkflowStateDto.properties.stateVersion.minimum).toBe(0);
    expect(schemas.TransitionCandidateDto.oneOf).toHaveLength(2);
    const blocked = schemas.TransitionCandidateDto.oneOf.find(
      (arm: any) => arm.properties.blocked.const === true,
    );
    const unblocked = schemas.TransitionCandidateDto.oneOf.find(
      (arm: any) => arm.properties.blocked.const === false,
    );
    for (const arm of schemas.TransitionCandidateDto.oneOf) {
      expect(arm.required).toEqual(
        expect.arrayContaining(["toStageId", "transitionKind", "stateVersion", "blocked"]),
      );
    }
    expect(blocked.required).toContain("blockedReasons");
    expect(blocked.properties.blockedReasons.minItems).toBe(1);
    expect(unblocked.properties.blockedReasons).toBeUndefined();
  });

  it("publishes each authorization denial with matching guidance", () => {
    const schema = (contractJsonSchemas() as any).ExecutionAuthorizationResult;
    const denials = schema.oneOf.filter((arm: any) => arm.properties.decision.const === "denied");

    expect(denials).toHaveLength(6);
    const selectionRequired = denials.find(
      (arm: any) => arm.properties.reason.const === "workflow_selection_required",
    );
    expect(selectionRequired.properties.guidance.properties.kind.const).toBe("select_workflow");
    expect(selectionRequired.properties.guidance.properties.nextOperation.const).toBe("workflow_start");
  });

  it("publishes the Project boundary and nested failure strictness", () => {
    const schemas = contractJsonSchemas() as any;
    expect(schemas.ProjectMarkerDto.required).toEqual(["schemaVersion", "projectId"]);
    expect(schemas.ProjectMarkerDto.properties.schemaVersion.const).toBe(1);
    expect(schemas.ProjectMarkerDto.properties.projectId.pattern).toBe("^project-[a-z0-9-]+$");
    expect(schemas.ProjectMarkerDto.properties.projectId.maxLength).toBe(128);
    expect(schemas.ProjectInitRequest.required).toEqual(["projectRoot"]);
    expect(schemas.ProjectInfoDto.properties.projectId.pattern).toBe("^project-[a-z0-9-]+$");
    expect(schemas.ProjectInfoDto.properties.projectId.maxLength).toBe(128);
    expect(schemas.ProjectDiscoveryDto.oneOf).toHaveLength(4);

    const initialized = schemas.ProjectDiscoveryDto.oneOf.find(
      (arm: any) => arm.properties.status.const === "initialized",
    );
    expect(initialized.properties.projectId.pattern).toBe("^project-[a-z0-9-]+$");
    expect(initialized.properties.projectId.maxLength).toBe(128);
    const invalid = schemas.ProjectDiscoveryDto.oneOf.find(
      (arm: any) => arm.properties.status.const === "invalid",
    );
    expect(invalid.properties.failure.additionalProperties).toBe(false);
    expect(invalid.properties.failure.properties.code.enum).toEqual([
      "invalid_request",
      "unavailable",
    ]);
    const mismatch = schemas.ProjectDiscoveryDto.oneOf.find(
      (arm: any) => arm.properties.status.const === "mismatch",
    );
    expect(mismatch.properties.markerProjectId.pattern).toBe("^project-[a-z0-9-]+$");
    expect(mismatch.properties.markerProjectId.maxLength).toBe(128);
    expect(mismatch.properties.registryProjectId.pattern).toBe("^project-[a-z0-9-]+$");
    expect(mismatch.properties.registryProjectId.maxLength).toBe(128);
    expect(mismatch.required).toEqual(expect.arrayContaining([
      "workspacePath",
      "projectRoot",
      "markerProjectId",
      "registryProjectId",
    ]));
  });

  it("D9: publishes strict nested reason and conflict arms", () => {
    const schemas = contractJsonSchemas() as any;
    const reason = schemas.ResolvedContextDto.properties.assets.items.properties.reason;
    const excluded = reason.oneOf.find((arm: any) => arm.properties.kind.const === "excluded");
    const unavailable = reason.oneOf.find((arm: any) => arm.properties.kind.const === "unavailable");

    for (const arm of excluded.properties.detail.oneOf) {
      expect(arm.additionalProperties).toBe(false);
    }
    for (const arm of unavailable.properties.detail.oneOf) {
      expect(arm.additionalProperties).toBe(false);
    }

    const conflict = schemas.ResolvedContextDto.properties.conflicts.items;
    for (const arm of conflict.oneOf) {
      expect(arm.additionalProperties).toBe(false);
    }
  });
});
