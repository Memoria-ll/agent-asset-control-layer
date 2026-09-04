import { describe, expect, it } from "vitest";
// The capability API is imported through the package entry point so that a member
// reachable inside the package but absent from `src/index.ts` — and therefore
// unreachable for `core` and `vscode-extension` — fails here.
import {
  buildCapabilityCatalog,
  evaluateCapabilityDependencies,
  featureSetContains,
  validateCapabilityContext,
} from "../src/index.ts";
import type {
  AssetResult,
  CapabilityDependency,
  CapabilityFeatureId,
  CapabilityId,
  CapabilityOffer,
  CapabilityReference,
} from "../src/index.ts";

const capabilityId = (value: string): CapabilityId => value as CapabilityId;
const featureId = (value: string): CapabilityFeatureId => value as CapabilityFeatureId;

const expectValue = <Value>(result: AssetResult<Value>): Value => {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.failure.message);
  return result.value;
};

const definition = (id: string, features: readonly string[] = []) => ({
  capabilityId: capabilityId(id),
  displayName: id,
  features: features.map(featureId),
});

const reference = (id: string, features?: readonly string[]): CapabilityReference => ({
  capabilityId: capabilityId(id),
  ...(features === undefined ? {} : { features: features.map(featureId) }),
});

const offer = (
  id: string,
  features: readonly string[] = [],
  permission: CapabilityOffer["permission"] = "allowed",
): CapabilityOffer => ({
  capabilityId: capabilityId(id),
  features: features.map(featureId),
  permission,
});

const context = (
  definitions: readonly ReturnType<typeof definition>[],
  offers: readonly CapabilityOffer[],
) => ({ catalog: expectValue(buildCapabilityCatalog(definitions)), offers });

describe("capability catalog and dependency semantics", () => {
  it("C1 maps valid definitions into a catalog", () => {
    const catalog = expectValue(buildCapabilityCatalog([
      definition("filesystem", ["read", "write"]),
      definition("network"),
    ]));

    expect([...catalog.keys()]).toEqual([capabilityId("filesystem"), capabilityId("network")]);
    expect(catalog.get(capabilityId("filesystem"))?.features).toEqual([featureId("read"), featureId("write")]);
  });

  it("C2 rejects duplicate definition ids", () => {
    const result = buildCapabilityCatalog([definition("filesystem"), definition("filesystem")]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.details?.map((item) => item.code)).toContain("duplicate_capability_id");
  });

  it("C3 rejects duplicate features", () => {
    const result = buildCapabilityCatalog([definition("filesystem", ["read", "read"])]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.details?.map((item) => item.code)).toContain("non_canonical_feature_list");
  });

  it("C4 accepts a valid feature subset", () => {
    const catalog = context([definition("filesystem", ["read", "write"])], [offer("filesystem", ["read"])]);
    expect(expectValue(validateCapabilityContext(catalog)).offers).toEqual([offer("filesystem", ["read"])]);
    const result = expectValue(evaluateCapabilityDependencies([
      { strength: "required", capability: reference("filesystem", ["read"]) },
    ], catalog));

    expect(result).toEqual({ ok: true });
  });

  it("C5 rejects a requirement whose feature is not offered", () => {
    const catalog = context([definition("filesystem", ["read", "write"])], [offer("filesystem", ["read"])]);
    const result = expectValue(evaluateCapabilityDependencies([
      { strength: "required", capability: reference("filesystem", ["write"]) },
    ], catalog));

    expect(result).toMatchObject({ ok: false, failedCapabilities: [capabilityId("filesystem")] });
  });

  it("C6 does not union partial offers", () => {
    const catalog = context([definition("filesystem", ["read", "write"])], [
      offer("filesystem", ["read"]),
      offer("filesystem", ["write"]),
    ]);
    const result = expectValue(evaluateCapabilityDependencies([
      { strength: "required", capability: reference("filesystem", ["read", "write"]) },
    ], catalog));

    expect(result.ok).toBe(false);
  });

  it("C7 treats an absent offer as unavailable", () => {
    const catalog = context([definition("filesystem")], []);
    const result = expectValue(evaluateCapabilityDependencies([
      { strength: "required", capability: reference("filesystem") },
    ], catalog));

    expect(result).toMatchObject({ ok: false, failedCapabilities: [capabilityId("filesystem")] });
  });

  it("C8 accepts a valid fallback relation", () => {
    const catalog = context([definition("filesystem"), definition("workspace")], [offer("workspace")]);
    const result = expectValue(evaluateCapabilityDependencies([
      { strength: "fallback", capability: reference("workspace"), fallbackFor: reference("filesystem") },
      { strength: "required", capability: reference("filesystem") },
    ], catalog));

    expect(result).toMatchObject({
      ok: true,
      degradedCapabilities: [{ capabilityId: capabilityId("filesystem"), strength: "required", fallbackCapabilityId: capabilityId("workspace") }],
    });
  });

  it("C9 rejects a fallback whose primary is not declared", () => {
    const result = evaluateCapabilityDependencies([
      { strength: "fallback", capability: reference("workspace"), fallbackFor: reference("filesystem") },
    ], context([definition("workspace")], [offer("workspace")]));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.details?.map((item) => item.code)).toContain("unknown_fallback_primary");
  });

  it("C10 rejects multiple fallbacks for one primary", () => {
    const result = evaluateCapabilityDependencies([
      { strength: "required", capability: reference("filesystem") },
      { strength: "fallback", capability: reference("workspace-a"), fallbackFor: reference("filesystem") },
      { strength: "fallback", capability: reference("workspace-b"), fallbackFor: reference("filesystem") },
    ], context([definition("filesystem"), definition("workspace-a"), definition("workspace-b")], []));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.details?.map((item) => item.code)).toContain("duplicate_fallback");
  });

  it("C11 keeps a missing preferred capability as degraded", () => {
    const catalog = context([definition("filesystem")], []);
    const result = expectValue(evaluateCapabilityDependencies([
      { strength: "preferred", capability: reference("filesystem") },
    ], catalog));

    expect(result).toMatchObject({
      ok: true,
      degradedCapabilities: [{ capabilityId: capabilityId("filesystem"), strength: "preferred" }],
    });
  });

  it("C12 returns dependencies and reasons in canonical order", () => {
    const catalog = context([
      definition("filesystem"),
      definition("network"),
      definition("workspace"),
    ], []);
    const dependencies: CapabilityDependency[] = [
      { strength: "optional", capability: reference("network") },
      { strength: "preferred", capability: reference("workspace") },
      { strength: "optional", capability: reference("filesystem") },
    ];
    const result = expectValue(evaluateCapabilityDependencies(dependencies, catalog));

    if (!result.ok) throw new Error("Expected canonical degradation outcome.");
    expect(result.degradedCapabilities?.map((item) => item.capabilityId)).toEqual([
      capabilityId("filesystem"),
      capabilityId("network"),
      capabilityId("workspace"),
    ]);
    expect(result.degradation?.reasons.map((reason) => reason.match(/Capability "([^"]+)"/)?.[1])).toEqual([
      "filesystem",
      "network",
      "workspace",
    ]);
    expect(featureSetContains([featureId("read"), featureId("write")], [featureId("read")])).toBe(true);
  });

  it("C13 rejects a requirement whose feature the definition does not declare", () => {
    const catalog = context([definition("filesystem", ["read", "write"])], [offer("filesystem", ["read"])]);
    const result = evaluateCapabilityDependencies([
      { strength: "required", capability: reference("filesystem", ["writ"]) },
    ], catalog);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.details?.map((item) => item.code)).toContain("unknown_capability_feature");
      expect(result.failure.details?.map((item) => item.path)).toContainEqual(["dependencies", "0", "capability", "features"]);
    }
  });

  it("C14 keeps a capability absent from the catalog a runtime absence", () => {
    const catalog = context([definition("workspace")], [offer("workspace")]);
    const result = expectValue(evaluateCapabilityDependencies([
      { strength: "required", capability: reference("filesystem", ["read"]) },
    ], catalog));

    expect(result).toMatchObject({ ok: false, failedCapabilities: [capabilityId("filesystem")] });
  });

  it("C15 collapses degradations that differ only in their features", () => {
    const catalog = context([definition("filesystem", ["read", "write"])], []);
    const result = expectValue(evaluateCapabilityDependencies([
      { strength: "optional", capability: reference("filesystem", ["read"]) },
      { strength: "optional", capability: reference("filesystem", ["write"]) },
    ], catalog));

    if (result.ok !== true) throw new Error("Expected a degraded outcome.");
    expect(result.degradedCapabilities).toEqual([
      { capabilityId: capabilityId("filesystem"), strength: "optional" },
    ]);
    expect(result.degradation?.reasons).toEqual([
      'Capability "filesystem" with optional strength is unavailable.',
    ]);
  });

  it("C16 collapses required failure reasons that differ only in their features", () => {
    const catalog = context([definition("filesystem", ["read", "write"])], []);
    const result = expectValue(evaluateCapabilityDependencies([
      { strength: "required", capability: reference("filesystem", ["read"]) },
      { strength: "required", capability: reference("filesystem", ["write"]) },
    ], catalog));

    expect(result).toEqual({
      ok: false,
      kind: "unavailable",
      failedCapabilities: [capabilityId("filesystem")],
      reasons: ['Capability "filesystem" with required strength is unavailable.'],
    });
  });

  it.each([
    { name: "repeats its primary reference", features: ["read"] },
    { name: "requires more features than its primary", features: ["read", "write"] },
  ])("C17 rejects a same-capability fallback that $name", ({ features }) => {
    const catalog = context([definition("filesystem", ["read", "write"])], []);
    const result = evaluateCapabilityDependencies([
      { strength: "required", capability: reference("filesystem", ["read"]) },
      { strength: "fallback", capability: reference("filesystem", features), fallbackFor: reference("filesystem", ["read"]) },
    ], catalog);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.details?.map((item) => item.code)).toContain("redundant_fallback");
  });

  it("C19 accepts a fallback on a disjoint feature set of the same capability", () => {
    const catalog = context([definition("filesystem", ["read", "write"])], [offer("filesystem", ["write"])]);
    const result = expectValue(evaluateCapabilityDependencies([
      { strength: "required", capability: reference("filesystem", ["read"]) },
      { strength: "fallback", capability: reference("filesystem", ["write"]), fallbackFor: reference("filesystem", ["read"]) },
    ], catalog));

    expect(result).toMatchObject({
      ok: true,
      degradedCapabilities: [{
        capabilityId: capabilityId("filesystem"),
        strength: "required",
        fallbackCapabilityId: capabilityId("filesystem"),
      }],
    });
  });

  it("C18 accepts a fallback on a weaker feature set of the same capability", () => {
    const catalog = context([definition("filesystem", ["read", "write"])], [offer("filesystem", ["read"])]);
    const result = expectValue(evaluateCapabilityDependencies([
      { strength: "required", capability: reference("filesystem", ["read", "write"]) },
      { strength: "fallback", capability: reference("filesystem", ["read"]), fallbackFor: reference("filesystem", ["read", "write"]) },
    ], catalog));

    expect(result).toMatchObject({
      ok: true,
      degradedCapabilities: [{
        capabilityId: capabilityId("filesystem"),
        strength: "required",
        fallbackCapabilityId: capabilityId("filesystem"),
      }],
    });
  });
  it("T1: rejects a denied offer for a required dependency", () => {
    const catalog = context([definition("filesystem")], [offer("filesystem", [], "denied")]);
    const result = expectValue(evaluateCapabilityDependencies([
      { strength: "required", capability: reference("filesystem") },
    ], catalog));

    expect(result).toMatchObject({
      ok: false,
      kind: "not_allowed",
      failedCapabilities: [capabilityId("filesystem")],
    });
  });

  it("T2: degrades an optional dependency when its offer is denied", () => {
    const catalog = context([definition("filesystem")], [offer("filesystem", [], "denied")]);
    const result = expectValue(evaluateCapabilityDependencies([
      { strength: "optional", capability: reference("filesystem") },
    ], catalog));

    expect(result).toMatchObject({
      ok: true,
      degradedCapabilities: [{ capabilityId: capabilityId("filesystem"), strength: "optional" }],
      degradation: { reasons: [expect.stringContaining("is not permitted.")] },
    });
  });

  it("T3: distinguishes denied and missing capability reasons", () => {
    const denied = expectValue(evaluateCapabilityDependencies([
      { strength: "optional", capability: reference("filesystem") },
    ], context([definition("filesystem")], [offer("filesystem", [], "denied")])));
    const missing = expectValue(evaluateCapabilityDependencies([
      { strength: "optional", capability: reference("filesystem") },
    ], context([definition("filesystem")], [])));

    expect(denied).toMatchObject({
      degradation: { reasons: ['Capability "filesystem" with optional strength is not permitted.'] },
    });
    expect(missing).toMatchObject({
      degradation: { reasons: ['Capability "filesystem" with optional strength is unavailable.'] },
    });
  });

  it("T4: rejects an offer without permission", () => {
    const invalidOffer = {
      capabilityId: capabilityId("filesystem"),
      features: [],
    } as unknown as CapabilityOffer;
    const result = validateCapabilityContext(context([definition("filesystem")], [invalidOffer]));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.details?.map((item) => item.code)).toContain("invalid_capability_permission");
    }
  });

  it("T5: rejects offers that differ only in permission", () => {
    // The duplicate key excludes permission because offers do not identify their provider.
    const result = validateCapabilityContext(context([definition("filesystem")], [
      offer("filesystem", ["read"], "allowed"),
      offer("filesystem", ["read"], "denied"),
    ]));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.details?.map((item) => item.code)).toContain("duplicate_capability_offer");
    }
  });

  it("T6: keeps the failure discriminator on a spread and a serialized outcome", () => {
    const catalog = context([definition("filesystem")], [offer("filesystem", [], "denied")]);
    const result = expectValue(evaluateCapabilityDependencies([
      { strength: "required", capability: reference("filesystem") },
    ], catalog));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect({ ...result }.kind).toBe("not_allowed");
    expect(JSON.parse(JSON.stringify(result)).kind).toBe("not_allowed");
  });
});
