import { describe, expect, it } from "vitest";
import { parseResolveRequest } from "@aacl/shared";
import {
  buildCapabilityCatalog,
  buildMetadataCatalog,
  parseBindingDocument,
  resolveBindings,
  resolveScope,
  toAssetCandidate,
  validateCapabilityContext,
  type AssetResult,
  type CapabilityId,
  type CanonicalBinding,
  type CapabilityResolutionContext,
} from "../src/index.ts";
import type { AssetRevision, ModelId, ProviderId, RoleId, RuntimeId } from "@aacl/shared";

const unwrap = <Value>(result: AssetResult<Value>): Value => {
  if (!result.ok) throw new Error(result.failure.message);
  return result.value;
};
const binding = (id: string, metadata: string, operation: "add" | "disable" = "add"): CanonicalBinding =>
  unwrap(parseBindingDocument(`---
schema-version: 4
id: ${id}
type: binding
tier: core
operation: ${operation}
scope.role: [reviewer]
${metadata}---
`));
const catalog = unwrap(buildMetadataCatalog({
  revision: "catalog-revision" as never,
  roles: [{ roleId: "reviewer" as RoleId, displayName: "Reviewer" }],
  taskTypes: [],
  providers: [
    { providerId: "azure" as ProviderId, displayName: "Azure" },
    { providerId: "openai" as ProviderId, displayName: "OpenAI" },
  ],
  runtimes: [{ runtimeId: "codex" as RuntimeId, displayName: "Codex", providerId: "openai" as ProviderId }],
  models: [
    { modelId: "gpt-5" as ModelId, displayName: "GPT-5", providerId: "openai" as ProviderId },
    { modelId: "other-model" as ModelId, displayName: "Other", providerId: "azure" as ProviderId },
  ],
  roleModelRelations: [],
}));

const entriesFor = (bindings: readonly CanonicalBinding[], capabilityContext?: CapabilityResolutionContext) => {
  const context = parseResolveRequest({ context: {
    executionMode: "advisory_preparation", workflow: { kind: "none" }, roleId: "reviewer",
  } }).context;
  const candidates = bindings.map((item, index) => unwrap(toAssetCandidate(item.asset, {
    revision: `revision-${index}` as AssetRevision,
    source: { layer: item.asset.operation === "disable" ? "project" : "global", sourceId: `source-${index}` },
  })));
  const evaluations = unwrap(resolveScope({
    context, snapshot: { candidates }, ...(capabilityContext === undefined ? {} : { capabilityContext }),
  })).evaluations;
  return bindings.map((item, index) => ({
    binding: item,
    evaluation: evaluations.find(({ candidate }) => candidate === candidates[index])!,
    source: item.asset.operation === "disable"
      ? { layer: "project" as const, projectId: "project-aacl" as never }
      : { layer: "global" as const },
  }));
};

describe("binding resolution", () => {
  it("preserves generic applicability without choosing a winner", () => {
    const first = binding("reviewer-first", "metadata.target-kind: model\nmetadata.model-id: gpt-5\n");
    const second = binding("reviewer-second", "metadata.target-kind: model\nmetadata.model-id: gpt-5\n");
    const result = unwrap(resolveBindings({ entries: entriesFor([first, second]), catalog }));
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.every(({ applicability }) => applicability.kind === "included")).toBe(true);
    expect(result.candidates.every((candidate) => !Object.hasOwn(candidate, "winner"))).toBe(true);
  });

  it("keeps target availability separate from applicability", () => {
    const mismatch = binding("reviewer-mismatch", "metadata.target-kind: runtime-model\nmetadata.runtime-id: codex\nmetadata.model-id: other-model\n");
    const result = unwrap(resolveBindings({ entries: entriesFor([mismatch]), catalog }));
    expect(result.candidates[0]).toMatchObject({
      applicability: { kind: "included" },
      targetAvailability: { status: "unavailable", issues: [{ kind: "target_provider_mismatch" }] },
    });
  });

  it("reports every missing component of a runtime-model target", () => {
    const missing = binding("missing-pair", "metadata.target-kind: runtime-model\nmetadata.runtime-id: absent-runtime\nmetadata.model-id: absent-model\n");
    const result = unwrap(resolveBindings({ entries: entriesFor([missing]), catalog }));
    expect(result.candidates[0]).toMatchObject({
      targetAvailability: {
        status: "unavailable",
        issues: [
          { kind: "target_missing", targetId: "absent-runtime" },
          { kind: "target_missing", targetId: "absent-model" },
        ],
      },
    });
  });

  it("preserves capability evidence from the generic resolver", () => {
    const candidate = binding("reviewer-capability", "capability.required: [filesystem-read]\nmetadata.target-kind: model\nmetadata.model-id: gpt-5\n");
    const capabilityCatalog = unwrap(buildCapabilityCatalog([
      { capabilityId: "filesystem-read" as CapabilityId, displayName: "Filesystem read", features: [] },
    ]));
    const capabilityContext = unwrap(validateCapabilityContext({
      catalog: capabilityCatalog,
      offers: [{ capabilityId: "filesystem-read" as CapabilityId, features: [], permission: "denied" }],
    }));
    const result = unwrap(resolveBindings({ entries: entriesFor([candidate], capabilityContext), catalog }));
    expect(result.candidates[0]).toMatchObject({
      applicability: { kind: "unavailable", detail: { cause: "capability_not_allowed", failedCapabilities: ["filesystem-read"] } },
      targetAvailability: { status: "available" },
    });
  });

  it("reports fallback links and integrity without activating fallback", () => {
    const primary = binding("primary", "metadata.target-kind: model\nmetadata.model-id: missing\n");
    const fallback = binding("fallback", "metadata.target-kind: model\nmetadata.model-id: gpt-5\nmetadata.fallback-for: primary\n");
    const missing = binding("missing-link", "metadata.target-kind: model\nmetadata.model-id: gpt-5\nmetadata.fallback-for: absent\n");
    const result = unwrap(resolveBindings({ entries: entriesFor([fallback, primary, missing]), catalog }));
    const byId = (id: string) => result.candidates.find((value) => value.operation !== "disable" && value.definition.bindingId === id);
    expect(byId("fallback")).toMatchObject({ fallbackRelation: { kind: "linked", primaryBindingId: "primary" } });
    expect(byId("fallback")).not.toHaveProperty("status", "fallback");
    expect(byId("missing-link")).toMatchObject({ fallbackRelation: { kind: "missing", primaryBindingId: "absent" } });
  });

  it("resolves a long fallback chain without recursive traversal", () => {
    const template = binding("chain-0", "metadata.target-kind: model\nmetadata.model-id: gpt-5\n");
    const templateEntry = entriesFor([template])[0]!;
    const length = 12_000;
    const entries = Array.from({ length }, (_, index) => {
      const bindingId = `chain-${index}` as never;
      const fallbackFor = index === length - 1 ? undefined : `chain-${index + 1}` as never;
      const item: CanonicalBinding = {
        ...template,
        bindingId,
        ...(fallbackFor === undefined ? {} : { fallbackFor }),
        asset: {
          ...template.asset,
          id: bindingId,
          metadata: fallbackFor === undefined
            ? template.asset.metadata
            : { ...template.asset.metadata, "fallback-for": fallbackFor },
        },
      };
      return {
        binding: item,
        evaluation: {
          ...templateEntry.evaluation,
          candidate: {
            ...templateEntry.evaluation.candidate,
            assetId: bindingId,
            revision: `revision-${index}` as never,
            source: { layer: "global" as const, sourceId: `source-${index}` },
          },
        },
        source: { layer: "global" as const },
      };
    });

    const result = unwrap(resolveBindings({ entries, catalog }));
    expect(result.candidates).toHaveLength(length);
    expect(result.candidates[0]).toMatchObject({ fallbackRelation: expect.objectContaining({ kind: "linked" }) });
  });

  it("keeps disable directives and disabled assets as generic evidence", () => {
    const base = binding("same-id", "metadata.target-kind: model\nmetadata.model-id: gpt-5\n");
    const disable = binding("same-id", "", "disable");
    const result = unwrap(resolveBindings({ entries: entriesFor([base, disable]), catalog }));
    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "add", applicability: expect.objectContaining({ kind: "disabled" }) }),
      expect.objectContaining({ operation: "disable", applicability: expect.objectContaining({ kind: "included" }) }),
    ]));
  });
});
