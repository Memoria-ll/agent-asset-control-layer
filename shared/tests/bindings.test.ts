import { describe, expect, it } from "vitest";
import {
  BINDING_REASON_KINDS,
  parseBindingCandidateDto,
  parseBindingDefinitionDto,
  parseBindingReasonDto,
  parseBindingRecordDto,
  parseBindingScopeDto,
  parseBindingTargetDto,
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

  it("requires fallbackFor on fallback candidates and retains structured reasons", () => {
    const definition = parseBindingDefinitionDto({ bindingId: "binding-1", target, description: "" });
    expect(definition.description).toBe("");
    expect(parseBindingCandidateDto({
      status: "fallback",
      definition: { ...definition, fallbackFor: "primary-1" },
      reasons: [{ kind: "fallback_primary_unavailable", primaryBindingId: "primary-1" }],
      source: { layer: "global" },
      revision: "revision-1",
      loadingTier: "core",
    })).toMatchObject({ status: "fallback", definition: { fallbackFor: "primary-1" } });
    expect(() => parseBindingCandidateDto({
      status: "fallback",
      definition,
      reasons: [{ kind: "eligible" }],
      source: { layer: "global" },
      revision: "revision-1",
      loadingTier: "core",
    })).toThrow();
    expect(() => parseBindingCandidateDto({
      status: "fallback",
      definition: { ...definition, fallbackFor: "primary-1" },
      fallbackFor: "primary-1",
      reasons: [{ kind: "fallback_primary_unavailable", primaryBindingId: "primary-1" }],
      source: { layer: "global" },
      revision: "revision-1",
      loadingTier: "core",
    })).toThrow();
    expect(() => parseBindingCandidateDto({
      status: "unavailable",
      bindingId: "binding-1",
      reasons: [{ kind: "eligible" }],
      source: { layer: "global" },
      revision: "revision-1",
      loadingTier: "core",
    })).toThrow();
    expect(() => parseBindingCandidateDto({
      status: "eligible",
      definition: { ...definition, fallbackFor: "primary-1" },
      reasons: [{ kind: "eligible" }],
      source: { layer: "global" },
      revision: "revision-1",
      loadingTier: "core",
    })).toThrow();
    expect(() => parseBindingCandidateDto({
      status: "fallback",
      definition: { ...definition, fallbackFor: "primary-1" },
      reasons: [{ kind: "fallback_primary_unavailable", primaryBindingId: "primary-2" }],
      source: { layer: "global" },
      revision: "revision-1",
      loadingTier: "core",
    })).toThrow();
    expect(() => parseBindingCandidateDto({
      status: "unavailable",
      bindingId: "binding-1",
      definition: { ...definition, bindingId: "binding-2" },
      reasons: [{ kind: "target_missing", targetId: "missing" }],
      source: { layer: "global" },
      revision: "revision-1",
      loadingTier: "core",
    })).toThrow();
    expect(() => parseBindingCandidateDto({
      status: "unavailable",
      bindingId: "binding-1",
      reasons: [{ kind: "invalid_binding", bindingId: "binding-2" }],
      source: { layer: "global" },
      revision: "revision-1",
      loadingTier: "core",
    })).toThrow();
    expect(parseBindingCandidateDto({
      status: "unavailable",
      bindingId: "binding-1",
      reasons: [{ kind: "binding_overridden", actorBindingId: "binding-2" }],
      source: { layer: "global" },
      revision: "revision-1",
      loadingTier: "core",
    })).toMatchObject({ bindingId: "binding-1" });
  });

  it("parses a fallback candidate's own reason through the standalone reason schema", () => {
    const definition = parseBindingDefinitionDto({ bindingId: "binding-1", target, description: "" });
    const reason = {
      kind: "fallback_primary_unavailable" as const,
      primaryBindingId: "primary-1",
      degradedCapabilities: [{ capabilityId: "browser-dom", strength: "optional" as const }],
    };
    expect(parseBindingCandidateDto({
      status: "fallback",
      definition: { ...definition, fallbackFor: "primary-1" },
      reasons: [reason],
      source: { layer: "global" },
      revision: "revision-1",
      loadingTier: "core",
    }).reasons[0]).toEqual(reason);
    expect(parseBindingReasonDto(reason)).toEqual(reason);
  });

  it("publishes no reason kind outside the exported closed set", () => {
    expect(BINDING_REASON_KINDS).not.toContain("context_missing");
    expect(() => parseBindingReasonDto({ kind: "context_missing", axis: "roleId" })).toThrow();
  });

  it("reports malformed definitions through the response error shape", () => {
    const result = tryParseBindingDefinitionDto({ bindingId: "binding-1", target, description: "", unknown: true });
    expect(result).toMatchObject({ ok: false, error: { code: "internal" } });
  });
});
