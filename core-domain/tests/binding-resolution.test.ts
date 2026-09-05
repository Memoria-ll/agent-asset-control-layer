import { describe, expect, it } from "vitest";
import { parseResolveRequest } from "@aacl/shared";
import {
  buildMetadataCatalog,
  buildCapabilityCatalog,
  parseBindingDocument,
  resolveBindings,
  resolveScope,
  toAssetCandidate,
  validateCapabilityContext,
  type AssetResult,
  type CapabilityId,
  type CanonicalBinding,
} from "../src/index.ts";
import type { AssetRevision, ModelId, ProviderId, RoleId, RuntimeId } from "@aacl/shared";
import type { CapabilityResolutionContext } from "../src/index.ts";

const unwrap = <Value>(result: AssetResult<Value>): Value => {
  if (!result.ok) throw new Error(result.failure.message);
  return result.value;
};

const binding = (id: string, metadata: string, scope = "", operation: "add" | "override" | "disable" = "add"): CanonicalBinding =>
  unwrap(parseBindingDocument(`---
schema-version: 3
id: ${id}
type: binding
tier: core
operation: ${operation}
${scope}${metadata}---
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
    { modelId: "other-model" as ModelId, displayName: "Other model", providerId: "azure" as ProviderId },
  ],
  roleModelRelations: [],
}));

const entriesFor = (
  bindings: readonly CanonicalBinding[],
  sources: readonly { readonly layer: "global" | "personal" | "project"; readonly sourceId: string }[] = [],
  capabilityContext?: CapabilityResolutionContext,
) => {
  const context = parseResolveRequest({
    context: { executionMode: "advisory_preparation", workflow: { kind: "none" }, roleId: "reviewer" },
  }).context;
  const candidates = bindings.map((item, index) => unwrap(toAssetCandidate(item.asset, {
    revision: `revision-${item.bindingId}` as AssetRevision,
    source: sources[index] ?? { layer: "global", sourceId: `source-${item.bindingId}` },
  })));
  const evaluations = unwrap(resolveScope({
    context,
    snapshot: { candidates },
    ...(capabilityContext === undefined ? {} : { capabilityContext }),
  })).evaluations;
  return bindings.map((binding, index) => {
    const layer = sources[index]?.layer ?? "global";
    const candidate = candidates[index]!;
    const evaluation = evaluations.find((item) => item.candidate === candidate);
    if (evaluation === undefined) throw new Error("Missing evaluation for Binding candidate.");
    return {
      binding,
      evaluation,
      source: layer === "project"
        ? { layer, projectId: "project-aacl" as never }
        : { layer },
    };
  });
};

describe("binding resolution", () => {
  it("keeps multiple same-role models eligible and exposes no winner", () => {
    const first = binding("reviewer-first", "metadata.target-kind: model\nmetadata.model-id: gpt-5\n", "scope.role: [reviewer]\n");
    const second = binding("reviewer-second", "metadata.target-kind: model\nmetadata.model-id: gpt-5\n", "scope.role: [reviewer]\n");
    const third = binding("reviewer-third", "metadata.target-kind: model\nmetadata.model-id: gpt-5\n", "scope.role: [reviewer]\n");
    const result = unwrap(resolveBindings({
      entries: entriesFor([first, second, third]),
      catalog,
    }));

    expect(result.candidates.filter((candidate) => candidate.status === "eligible")).toHaveLength(3);
    expect(result.candidates.every((candidate) => !Object.hasOwn(candidate, "winner"))).toBe(true);
    expect(result.candidates[0]).toMatchObject({ revision: expect.any(String), source: { layer: "global" } });
  });

  it("marks a fallback only when its explicit primary is unavailable", () => {
    const primary = binding("reviewer-primary", "metadata.target-kind: model\nmetadata.model-id: missing-model\n", "scope.role: [reviewer]\n");
    const fallback = binding("reviewer-fallback", "metadata.target-kind: model\nmetadata.model-id: gpt-5\nmetadata.fallback-for: reviewer-primary\n", "scope.role: [reviewer]\n");
    const result = unwrap(resolveBindings({
      entries: entriesFor([fallback, primary]),
      catalog,
    }));

    expect(result.candidates.find((candidate) => candidate.definition?.bindingId === "reviewer-fallback"))
      .toMatchObject({ status: "fallback", definition: { fallbackFor: "reviewer-primary" } });
  });

  it("reports a runtime/model provider mismatch as unavailable", () => {
    const mismatch = binding("reviewer-mismatch", "metadata.target-kind: runtime-model\nmetadata.runtime-id: codex\nmetadata.model-id: other-model\n", "scope.role: [reviewer]\n");
    const result = unwrap(resolveBindings({
      entries: entriesFor([mismatch]),
      catalog,
    }));

    expect(result.candidates[0]).toMatchObject({
      status: "unavailable",
      reasons: [{ kind: "target_provider_mismatch", targetId: "other-model", providerId: "openai" }],
    });
  });

  it("maps a denied capability outcome to a structured unavailable reason", () => {
    const candidate = binding("reviewer-capability", "capability.required: [filesystem-read]\nmetadata.target-kind: model\nmetadata.model-id: gpt-5\n", "scope.role: [reviewer]\n");
    const capabilityCatalog = unwrap(buildCapabilityCatalog([
      { capabilityId: "filesystem-read" as CapabilityId, displayName: "Filesystem read", features: [] },
    ]));
    const capabilityContext = unwrap(validateCapabilityContext({
      catalog: capabilityCatalog,
      offers: [{ capabilityId: "filesystem-read" as CapabilityId, features: [], permission: "denied" }],
    }));
    const result = unwrap(resolveBindings({
      entries: entriesFor([candidate], [], capabilityContext),
      catalog,
    }));

    expect(result.candidates[0]).toMatchObject({
      status: "unavailable",
      reasons: [{ kind: "capability_not_allowed", capabilityId: "filesystem-read" }],
    });
  });

  it("maps allowed and missing capabilities from the generic resolver seam", () => {
    const candidate = binding("reviewer-capability", "capability.required: [filesystem-read]\nmetadata.target-kind: model\nmetadata.model-id: gpt-5\n", "scope.role: [reviewer]\n");
    const allowedCatalog = unwrap(buildCapabilityCatalog([
      { capabilityId: "filesystem-read" as CapabilityId, displayName: "Filesystem read", features: [] },
    ]));
    const allowedContext = unwrap(validateCapabilityContext({
      catalog: allowedCatalog,
      offers: [{ capabilityId: "filesystem-read" as CapabilityId, features: [], permission: "allowed" }],
    }));
    const allowed = unwrap(resolveBindings({
      entries: entriesFor([candidate], [], allowedContext),
      catalog,
    }));
    expect(allowed.candidates[0]).toMatchObject({ status: "eligible", reasons: [{ kind: "eligible" }] });

    const missingCatalog = unwrap(buildCapabilityCatalog([]));
    const missingContext = unwrap(validateCapabilityContext({ catalog: missingCatalog, offers: [] }));
    const missing = unwrap(resolveBindings({
      entries: entriesFor([candidate], [], missingContext),
      catalog,
    }));
    expect(missing.candidates[0]).toMatchObject({
      status: "unavailable",
      reasons: [{ kind: "capability_unavailable", capabilityId: "filesystem-read" }],
    });
  });

  it("retains soft capability degradation on an eligible candidate", () => {
    const candidate = binding("reviewer-capability", "capability.optional: [browser-dom]\nmetadata.target-kind: model\nmetadata.model-id: gpt-5\n", "scope.role: [reviewer]\n");
    const capabilityContext = unwrap(validateCapabilityContext({
      catalog: unwrap(buildCapabilityCatalog([])),
      offers: [],
    }));
    const result = unwrap(resolveBindings({
      entries: entriesFor([candidate], [], capabilityContext),
      catalog,
    }));

    expect(result.candidates[0]).toMatchObject({
      status: "eligible",
      reasons: [{
        kind: "eligible",
        degradedCapabilities: [{ capabilityId: "browser-dom", strength: "optional" }],
      }],
    });
  });

  it.each(["override", "disable"] as const)("keeps same-ID project %s paired with its own evaluation", (operation) => {
    const base = binding("same-id", "metadata.target-kind: model\nmetadata.model-id: gpt-5\n", "scope.role: [reviewer]\n");
    const overlay = binding(
      "same-id",
      operation === "override" ? "metadata.target-kind: model\nmetadata.model-id: gpt-5\n" : "",
      "scope.role: [reviewer]\n",
      operation,
    );
    const entries = entriesFor(
      [base, overlay],
      [
        { layer: "global", sourceId: "global-source" },
        { layer: "project", sourceId: "project-source" },
      ],
    );
    const result = unwrap(resolveBindings({ entries, catalog }));
    expect(result.candidates).toHaveLength(2);
    const statuses = result.candidates.map((candidate) => [candidate.status, candidate.reasons[0]?.kind]);
    if (operation === "override") {
      expect(statuses).toContainEqual(["unavailable", "binding_overridden"]);
      expect(statuses).toContainEqual(["eligible", "eligible"]);
      expect(result.candidates).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: { layer: "global" } }),
        expect.objectContaining({ source: { layer: "project", projectId: "project-aacl" } }),
      ]));
    } else {
      expect(statuses).toContainEqual(["unavailable", "binding_disabled"]);
    }
  });

  it("does not apply an overridden fallback relation from an inactive same-ID candidate", () => {
    const base = binding("same-id", "metadata.target-kind: model\nmetadata.model-id: gpt-5\nmetadata.fallback-for: missing-primary\n", "scope.role: [reviewer]\n");
    const overlay = binding("same-id", "metadata.target-kind: model\nmetadata.model-id: gpt-5\n", "scope.role: [reviewer]\n", "override");
    const result = unwrap(resolveBindings({
      entries: entriesFor([base, overlay], [
        { layer: "global", sourceId: "global-source" },
        { layer: "project", sourceId: "project-source" },
      ]),
      catalog,
    }));

    expect(result.candidates.find((candidate) => candidate.status === "unavailable"))
      .toMatchObject({ status: "unavailable", reasons: [{ kind: "binding_overridden" }] });
    expect(result.candidates.find((candidate) => candidate.status === "eligible"))
      .toMatchObject({ status: "eligible", definition: { bindingId: "same-id" } });
    expect(result.diagnostics).toEqual([]);
  });

  it("does not activate a fallback while its primary is eligible", () => {
    const primary = binding("reviewer-primary", "metadata.target-kind: model\nmetadata.model-id: gpt-5\n", "scope.role: [reviewer]\n");
    const fallback = binding("reviewer-fallback", "metadata.target-kind: model\nmetadata.model-id: gpt-5\nmetadata.fallback-for: reviewer-primary\n", "scope.role: [reviewer]\n");
    const result = unwrap(resolveBindings({
      entries: entriesFor([primary, fallback]),
      catalog,
    }));

    expect(result.candidates.find((candidate) => candidate.definition?.bindingId === "reviewer-fallback"))
      .toMatchObject({ status: "unavailable", reasons: [{ kind: "fallback_not_needed" }] });
  });
});
