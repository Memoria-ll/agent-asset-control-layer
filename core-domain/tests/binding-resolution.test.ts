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
    const statuses = result.candidates.map((candidate) => [candidate.status, candidate.reasons[0]?.kind]);
    if (operation === "override") {
      expect(result.candidates).toHaveLength(2);
      expect(statuses).toContainEqual(["unavailable", "binding_overridden"]);
      expect(statuses).toContainEqual(["eligible", "eligible"]);
      expect(result.candidates).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: { layer: "global" } }),
        expect.objectContaining({ source: { layer: "project", projectId: "project-aacl" } }),
      ]));
    } else {
      // The directive itself is not a candidate, so the disabled base stands alone.
      expect(result.candidates).toHaveLength(1);
      expect(statuses).toContainEqual(["unavailable", "binding_disabled"]);
    }
  });

  it("does not offer an applied disable directive as a Binding candidate", () => {
    const base = binding("same-id", "metadata.target-kind: model\nmetadata.model-id: gpt-5\n", "scope.role: [reviewer]\n");
    const directive = binding("same-id", "", "scope.role: [reviewer]\n", "disable");
    const result = unwrap(resolveBindings({
      entries: entriesFor([base, directive], [
        { layer: "global", sourceId: "global-source" },
        { layer: "project", sourceId: "project-source" },
      ]),
      catalog,
    }));

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      status: "unavailable",
      bindingId: "same-id",
      reasons: [{ kind: "binding_disabled", actorBindingId: "same-id" }],
      source: { layer: "global" },
    });
    expect(result.candidates.some((candidate) => candidate.reasons.some((reason) => reason.kind === "invalid_binding")))
      .toBe(false);
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

  it("leaves a longer fallback chain inactive while its head is eligible", () => {
    const head = binding("chain-head", "metadata.target-kind: model\nmetadata.model-id: gpt-5\n", "scope.role: [reviewer]\n");
    const first = binding("chain-first", "metadata.target-kind: model\nmetadata.model-id: gpt-5\nmetadata.fallback-for: chain-head\n", "scope.role: [reviewer]\n");
    const second = binding("chain-second", "metadata.target-kind: model\nmetadata.model-id: gpt-5\nmetadata.fallback-for: chain-first\n", "scope.role: [reviewer]\n");
    const result = unwrap(resolveBindings({
      entries: entriesFor([head, first, second]),
      catalog,
    }));

    expect(result.candidates.find((candidate) => candidate.definition?.bindingId === "chain-head"))
      .toMatchObject({ status: "eligible" });
    expect(result.candidates.find((candidate) => candidate.definition?.bindingId === "chain-first"))
      .toMatchObject({ status: "unavailable", reasons: [{ kind: "fallback_not_needed", primaryBindingId: "chain-head" }] });
    expect(result.candidates.find((candidate) => candidate.definition?.bindingId === "chain-second"))
      .toMatchObject({ status: "unavailable", reasons: [{ kind: "fallback_not_needed", primaryBindingId: "chain-first" }] });
    expect(result.candidates.filter((candidate) => candidate.status === "fallback")).toHaveLength(0);
  });

  it("activates the one fallback whose chain is unserved", () => {
    const head = binding("chain-head", "metadata.target-kind: model\nmetadata.model-id: missing-model\n", "scope.role: [reviewer]\n");
    const first = binding("chain-first", "metadata.target-kind: model\nmetadata.model-id: gpt-5\nmetadata.fallback-for: chain-head\n", "scope.role: [reviewer]\n");
    const second = binding("chain-second", "metadata.target-kind: model\nmetadata.model-id: gpt-5\nmetadata.fallback-for: chain-first\n", "scope.role: [reviewer]\n");
    const result = unwrap(resolveBindings({
      entries: entriesFor([head, first, second]),
      catalog,
    }));

    expect(result.candidates.find((candidate) => candidate.definition?.bindingId === "chain-head"))
      .toMatchObject({ status: "unavailable", reasons: [{ kind: "target_missing", targetId: "missing-model" }] });
    expect(result.candidates.find((candidate) => candidate.definition?.bindingId === "chain-first"))
      .toMatchObject({ status: "fallback", reasons: [{ kind: "fallback_primary_unavailable", primaryBindingId: "chain-head" }] });
    expect(result.candidates.find((candidate) => candidate.definition?.bindingId === "chain-second"))
      .toMatchObject({ status: "unavailable", reasons: [{ kind: "fallback_not_needed", primaryBindingId: "chain-first" }] });
  });

  it("does not cover a chain through an overridden revision's fallback relation", () => {
    const head = binding("chain-head", "metadata.target-kind: model\nmetadata.model-id: gpt-5\n", "scope.role: [reviewer]\n");
    // The overridden revision declares the relation; the revision that applies
    // does not, and its target is missing.
    const overriddenMiddle = binding("chain-middle", "metadata.target-kind: model\nmetadata.model-id: gpt-5\nmetadata.fallback-for: chain-head\n", "scope.role: [reviewer]\n");
    const effectiveMiddle = binding("chain-middle", "metadata.target-kind: model\nmetadata.model-id: missing-model\n", "scope.role: [reviewer]\n", "override");
    const tail = binding("chain-tail", "metadata.target-kind: model\nmetadata.model-id: gpt-5\nmetadata.fallback-for: chain-middle\n", "scope.role: [reviewer]\n");
    const result = unwrap(resolveBindings({
      entries: entriesFor([head, overriddenMiddle, effectiveMiddle, tail], [
        { layer: "global", sourceId: "global-head" },
        { layer: "global", sourceId: "global-middle" },
        { layer: "project", sourceId: "project-middle" },
        { layer: "global", sourceId: "global-tail" },
      ]),
      catalog,
    }));

    // Nothing at `chain-middle` serves, so its own fallback has to activate.
    expect(result.candidates.find((candidate) => candidate.definition?.bindingId === "chain-tail"))
      .toMatchObject({ status: "fallback", reasons: [{ kind: "fallback_primary_unavailable", primaryBindingId: "chain-middle" }] });
  });

  it("does not let a Binding with a missing primary cover the chain beneath it", () => {
    const first = binding("chain-first", "metadata.target-kind: model\nmetadata.model-id: gpt-5\nmetadata.fallback-for: chain-absent\n", "scope.role: [reviewer]\n");
    const second = binding("chain-second", "metadata.target-kind: model\nmetadata.model-id: gpt-5\nmetadata.fallback-for: chain-first\n", "scope.role: [reviewer]\n");
    const result = unwrap(resolveBindings({
      entries: entriesFor([first, second]),
      catalog,
    }));

    expect(result.candidates.find((candidate) => candidate.definition?.bindingId === "chain-first"))
      .toMatchObject({ status: "unavailable", reasons: [{ kind: "invalid_binding", bindingId: "chain-first" }] });
    expect(result.candidates.find((candidate) => candidate.definition?.bindingId === "chain-second"))
      .toMatchObject({ status: "fallback", reasons: [{ kind: "fallback_primary_unavailable", primaryBindingId: "chain-first" }] });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "missing_fallback_primary" }),
    ]));
  });

  it("does not let a cyclic Binding cover the chain beneath it", () => {
    const left = binding("cycle-left", "metadata.target-kind: model\nmetadata.model-id: gpt-5\nmetadata.fallback-for: cycle-right\n", "scope.role: [reviewer]\n");
    const right = binding("cycle-right", "metadata.target-kind: model\nmetadata.model-id: gpt-5\nmetadata.fallback-for: cycle-left\n", "scope.role: [reviewer]\n");
    const below = binding("cycle-below", "metadata.target-kind: model\nmetadata.model-id: gpt-5\nmetadata.fallback-for: cycle-right\n", "scope.role: [reviewer]\n");
    const result = unwrap(resolveBindings({
      entries: entriesFor([left, right, below]),
      catalog,
    }));

    for (const bindingId of ["cycle-left", "cycle-right"]) {
      expect(result.candidates.find((candidate) => candidate.definition?.bindingId === bindingId))
        .toMatchObject({ status: "unavailable", reasons: [{ kind: "invalid_binding", bindingId }] });
    }
    expect(result.candidates.find((candidate) => candidate.definition?.bindingId === "cycle-below"))
      .toMatchObject({ status: "fallback", reasons: [{ kind: "fallback_primary_unavailable", primaryBindingId: "cycle-right" }] });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "fallback_cycle" }),
    ]));
  });

  it("keeps the unsatisfied requirement when a capability failure decides the cause", () => {
    const candidate = binding(
      "reviewer-both",
      "capability.required: [filesystem-read]\nmetadata.target-kind: model\nmetadata.model-id: gpt-5\n",
      "requires: [missing-asset]\nscope.role: [reviewer]\n",
    );
    const capabilityContext = unwrap(validateCapabilityContext({
      catalog: unwrap(buildCapabilityCatalog([
        { capabilityId: "filesystem-read" as CapabilityId, displayName: "Filesystem read", features: [] },
      ])),
      offers: [{ capabilityId: "filesystem-read" as CapabilityId, features: [], permission: "denied" }],
    }));
    const result = unwrap(resolveBindings({
      entries: entriesFor([candidate], [], capabilityContext),
      catalog,
    }));

    expect(result.candidates[0]?.reasons).toEqual(expect.arrayContaining([
      { kind: "capability_not_allowed", capabilityId: "filesystem-read" },
      { kind: "requirement_unavailable", requirementId: "missing-asset" },
    ]));
  });

  it("rejects an entry whose evaluation belongs to another asset", () => {
    const first = binding("reviewer-first", "metadata.target-kind: model\nmetadata.model-id: gpt-5\n", "scope.role: [reviewer]\n");
    const second = binding("reviewer-second", "metadata.target-kind: model\nmetadata.model-id: gpt-5\n", "scope.role: [reviewer]\n");
    const entries = entriesFor([first, second]);
    const crossed = [{ ...entries[0]!, evaluation: entries[1]!.evaluation }];

    const result = resolveBindings({ entries: crossed, catalog });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("invalid_request");
      expect(result.failure.details).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "binding_candidate_mismatch" }),
      ]));
    }
  });

  it("names the unsatisfied requirement instead of calling the Binding malformed", () => {
    const dependent = binding(
      "reviewer-dependent",
      "metadata.target-kind: model\nmetadata.model-id: gpt-5\n",
      "requires: [missing-asset]\nscope.role: [reviewer]\n",
    );
    const result = unwrap(resolveBindings({
      entries: entriesFor([dependent]),
      catalog,
    }));

    expect(result.candidates[0]).toMatchObject({
      status: "unavailable",
      reasons: [{ kind: "requirement_unavailable", requirementId: "missing-asset" }],
    });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "missing_requirement",
        path: ["binding", "reviewer-dependent", "requires"],
      }),
    ]));
  });

  it("reports a fallback cycle even when every member's target is missing", () => {
    const left = binding("cycle-left", "metadata.target-kind: model\nmetadata.model-id: missing-model\nmetadata.fallback-for: cycle-right\n", "scope.role: [reviewer]\n");
    const right = binding("cycle-right", "metadata.target-kind: model\nmetadata.model-id: missing-model\nmetadata.fallback-for: cycle-left\n", "scope.role: [reviewer]\n");
    const result = unwrap(resolveBindings({
      entries: entriesFor([left, right]),
      catalog,
    }));

    for (const bindingId of ["cycle-left", "cycle-right"]) {
      expect(result.candidates.find((candidate) => candidate.definition?.bindingId === bindingId))
        .toMatchObject({ status: "unavailable", reasons: [{ kind: "target_missing", targetId: "missing-model" }] });
    }
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "fallback_cycle" }),
    ]));
  });

  it("reports a missing fallback primary even when the fallback's own target is missing", () => {
    const orphan = binding(
      "orphan-fallback",
      "metadata.target-kind: model\nmetadata.model-id: missing-model\nmetadata.fallback-for: absent-primary\n",
      "scope.role: [reviewer]\n",
    );
    const result = unwrap(resolveBindings({
      entries: entriesFor([orphan]),
      catalog,
    }));

    expect(result.candidates[0]).toMatchObject({
      status: "unavailable",
      reasons: [{ kind: "target_missing", targetId: "missing-model" }],
    });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "missing_fallback_primary" }),
    ]));
  });

  it("rejects a Binding whose declared Project scope is not a Marker identity", () => {
    const result = parseBindingDocument(`---
schema-version: 3
id: bad-project-scope
type: binding
tier: core
operation: add
scope.project: [not-a-marker]
metadata.target-kind: model
metadata.model-id: gpt-5
---
`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.details).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_project_id",
          path: ["document", "frontmatter", "scope.project"],
        }),
      ]));
    }
  });

  it("keeps the resolver conflict diagnostics on an unavailable Binding", () => {
    const orphan = binding(
      "orphan-override",
      "metadata.target-kind: model\nmetadata.model-id: gpt-5\n",
      "scope.role: [reviewer]\n",
      "override",
    );
    const result = unwrap(resolveBindings({
      entries: entriesFor([orphan], [{ layer: "project", sourceId: "project-source" }]),
      catalog,
    }));

    expect(result.candidates[0]).toMatchObject({ status: "unavailable", reasons: [{ kind: "invalid_binding" }] });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "operation_conflict" }),
    ]));
  });

  it("detects a fallback cycle whose edge runs through a Binding with a missing target", () => {
    const left = binding("cycle-left", "metadata.target-kind: model\nmetadata.model-id: missing-model\nmetadata.fallback-for: cycle-right\n", "scope.role: [reviewer]\n");
    const right = binding("cycle-right", "metadata.target-kind: model\nmetadata.model-id: gpt-5\nmetadata.fallback-for: cycle-left\n", "scope.role: [reviewer]\n");
    const result = unwrap(resolveBindings({
      entries: entriesFor([left, right]),
      catalog,
    }));

    expect(result.candidates.find((candidate) => candidate.definition?.bindingId === "cycle-left"))
      .toMatchObject({ status: "unavailable", reasons: [{ kind: "target_missing", targetId: "missing-model" }] });
    expect(result.candidates.find((candidate) => candidate.definition?.bindingId === "cycle-right"))
      .toMatchObject({ status: "unavailable", reasons: [{ kind: "invalid_binding", bindingId: "cycle-right" }] });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "fallback_cycle" }),
    ]));
  });

  it("keeps the offending directory selector diagnostics on an unavailable Binding", () => {
    const invalid = binding(
      "reviewer-directory",
      "metadata.target-kind: model\nmetadata.model-id: gpt-5\n",
      "scope.directory: [relative/path]\n",
    );
    const result = unwrap(resolveBindings({
      entries: entriesFor([invalid]),
      catalog,
    }));

    expect(result.candidates[0]).toMatchObject({ status: "unavailable", reasons: [{ kind: "invalid_binding" }] });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "invalid_directory",
        path: ["snapshot", "candidate", "reviewer-directory", "rule", "selectors", "directory"],
      }),
    ]));
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
