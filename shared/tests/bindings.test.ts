import { describe, expect, it } from "vitest";
import {
  parseBindingCandidateDto,
  parseBindingDefinitionDto,
  parseBindingRecordDto,
  parseBindingScopeDto,
  parseBindingTargetDto,
  parseSelectedStageRequirementsResponse,
  tryParseBindingDefinitionDto,
} from "../src/index.ts";

const target = { kind: "runtime-model" as const, runtimeId: "codex", modelId: "gpt-5" };

describe("Binding shared contract", () => {
  it("accepts every target arm and rejects impossible fields", () => {
    expect(parseBindingTargetDto({ kind: "provider", providerId: "openai" })).toEqual({ kind: "provider", providerId: "openai" });
    expect(parseBindingTargetDto({ kind: "runtime", runtimeId: "codex" })).toEqual({ kind: "runtime", runtimeId: "codex" });
    expect(parseBindingTargetDto({ kind: "model", modelId: "gpt-5" })).toEqual({ kind: "model", modelId: "gpt-5" });
    expect(parseBindingTargetDto(target)).toEqual(target);
    expect(() => parseBindingTargetDto({ kind: "provider", providerId: "openai", modelId: "gpt-5" })).toThrow();
  });

  it("requires non-empty unique scope lists and preserves omitted keys", () => {
    expect(parseBindingScopeDto({ roleId: ["reviewer"] })).toEqual({ roleId: ["reviewer"] });
    expect(() => parseBindingScopeDto({ roleId: [] })).toThrow();
    expect(() => parseBindingScopeDto({ roleId: ["reviewer", "reviewer"] })).toThrow();
    expect(() => parseBindingScopeDto({ roleId: ["reviewer"], unknown: ["value"] })).toThrow();
  });

  it("keeps disable records free of definition fields", () => {
    expect(parseBindingRecordDto({
      operation: "add",
      definition: { bindingId: "binding-1", target: { kind: "model", modelId: "gpt-5" }, description: "" },
      source: { layer: "global" },
      revision: "revision-1",
      loadingTier: "core",
    }).source).toEqual({ layer: "global" });
    expect(parseBindingRecordDto({
      operation: "add",
      definition: { bindingId: "binding-1", target: { kind: "model", modelId: "gpt-5" }, description: "" },
      source: { layer: "personal" },
      revision: "revision-1",
      loadingTier: "core",
    }).source).toEqual({ layer: "personal" });
    expect(parseBindingRecordDto({
      operation: "disable",
      bindingId: "binding-1",
      scope: { roleId: ["reviewer"] },
      source: { layer: "project", projectId: "project-1" },
      revision: "revision-1",
      loadingTier: "core",
    })).toMatchObject({ operation: "disable", bindingId: "binding-1" });
    expect(() => parseBindingRecordDto({
      operation: "disable",
      bindingId: "binding-1",
      target,
      source: { layer: "project", projectId: "project-1" },
      revision: "revision-1",
      loadingTier: "core",
    })).toThrow();
    expect(() => parseBindingRecordDto({
      operation: "add",
      definition: { bindingId: "binding-1", target: { kind: "model", modelId: "gpt-5" }, description: "" },
      source: { layer: "project" },
      revision: "revision-1",
      loadingTier: "core",
    })).toThrow();
  });

  it("keeps applicability, target availability, and fallback relation independent", () => {
    const definition = parseBindingDefinitionDto({ bindingId: "binding-1", target, description: "" });
    expect(definition.description).toBe("");
    expect(parseBindingCandidateDto({
      operation: "add",
      definition: { ...definition, fallbackFor: "primary-1" },
      applicability: { kind: "included", explanation: "Matched.", matchedAxes: [] },
      targetAvailability: { status: "available" },
      fallbackRelation: { kind: "linked", primaryBindingId: "primary-1" },
      source: { layer: "global" },
      revision: "revision-1",
      loadingTier: "core",
    })).toMatchObject({
      operation: "add",
      applicability: { kind: "included" },
      targetAvailability: { status: "available" },
      fallbackRelation: { kind: "linked" },
    });

    expect(parseBindingCandidateDto({
      operation: "disable",
      bindingId: "binding-1",
      applicability: { kind: "disabled", explanation: "Disabled.", disabledBy: "binding-1" },
      source: { layer: "project", projectId: "project-1" },
      revision: "revision-1",
      loadingTier: "core",
    })).toMatchObject({ operation: "disable", bindingId: "binding-1" });

    expect(() => parseBindingCandidateDto({
      operation: "add",
      definition,
      applicability: { kind: "included", explanation: "Matched.", matchedAxes: [] },
      targetAvailability: { status: "unavailable", issues: [] },
      fallbackRelation: { kind: "none" },
      source: { layer: "global" },
      revision: "revision-1",
      loadingTier: "core",
    })).toThrow();
    expect(() => parseBindingCandidateDto({
      operation: "add",
      definition: { ...definition, fallbackFor: "primary-a" },
      applicability: { kind: "included", explanation: "Matched.", matchedAxes: [] },
      targetAvailability: { status: "available" },
      fallbackRelation: { kind: "linked", primaryBindingId: "primary-b" },
      source: { layer: "global" },
      revision: "revision-1",
      loadingTier: "core",
    })).toThrow();
    expect(() => parseBindingCandidateDto({
      operation: "add",
      definition,
      applicability: { kind: "included", explanation: "Matched.", matchedAxes: [] },
      targetAvailability: { status: "available" },
      fallbackRelation: { kind: "linked", primaryBindingId: "primary-a" },
      source: { layer: "global" },
      revision: "revision-1",
      loadingTier: "core",
    })).toThrow();
    expect(() => parseBindingCandidateDto({
      operation: "disable",
      bindingId: "binding-1",
      applicability: { kind: "disabled", explanation: "Disabled.", disabledBy: "binding-1" },
      targetAvailability: { status: "available" },
      source: { layer: "project", projectId: "project-1" },
      revision: "revision-1",
      loadingTier: "core",
    })).toThrow();
    expect(() => parseBindingCandidateDto({
      operation: "override",
      definition,
      applicability: { kind: "included", explanation: "Matched.", matchedAxes: [] },
      targetAvailability: { status: "available" },
      fallbackRelation: { kind: "none" },
      source: { layer: "global" },
      revision: "revision-1",
      loadingTier: "core",
    })).toThrow();
  });

  it("requires selected-stage responses to contain an outcome", () => {
    expect(() => parseSelectedStageRequirementsResponse({
      context: { executionMode: "advisory_preparation", workflow: { kind: "none" } },
    })).toThrow();
    expect(parseSelectedStageRequirementsResponse({
      context: { executionMode: "advisory_preparation", workflow: { kind: "none" } },
      outcome: "unavailable",
      diagnostics: [{ path: ["context", "workflow"], code: "selection_required", message: "Selection required." }],
    })).toMatchObject({ outcome: "unavailable" });
  });

  it("accepts only marker-shaped project ids", () => {
    expect(parseBindingScopeDto({ projectId: ["project-a"] })).toEqual({ projectId: ["project-a"] });
    expect(() => parseBindingScopeDto({ projectId: ["plain-a"] })).toThrow();
    expect(() => parseBindingRecordDto({
      operation: "override",
      definition: { bindingId: "binding-1", target, description: "" },
      source: { layer: "global" },
      revision: "revision-1",
      loadingTier: "core",
    })).toThrow();
  });

  it("reports malformed definitions through the response error shape", () => {
    const result = tryParseBindingDefinitionDto({ bindingId: "binding-1", target, description: "", unknown: true });
    expect(result).toMatchObject({ ok: false, error: { code: "internal" } });
  });
});
