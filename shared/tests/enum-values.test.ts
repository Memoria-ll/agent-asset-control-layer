import { describe, expect, it } from "vitest";
import {
  AssetType,
  AvailabilityStatus,
  CompatibilityStatus,
  CoreErrorCode,
  LoadingTier,
  ResolutionReasonKind,
} from "../src/index.js";

const enumValues = (schema: unknown): string[] => {
  const definition = (schema as { _zod: { def: { entries: Record<string, unknown> } } })._zod.def;
  return Object.keys(definition.entries);
};

describe("frozen contract enum values", () => {
  it.each([
    ["AssetType", AssetType, ["skill", "rule", "role", "workflow", "task-type", "policy", "guardrail", "knowledge"]],
    ["ResolutionReasonKind", ResolutionReasonKind, ["included", "excluded", "overridden", "disabled", "unavailable"]],
    ["AvailabilityStatus", AvailabilityStatus, ["available", "degraded", "unavailable"]],
    ["LoadingTier", LoadingTier, ["core", "discoverable", "on-demand"]],
    ["CoreErrorCode", CoreErrorCode, ["invalid_request", "not_found", "conflict", "unavailable", "incompatible_contract", "internal"]],
    ["CompatibilityStatus", CompatibilityStatus, ["compatible", "degraded", "incompatible"]],
  ])("keeps %s stable", (name, schema, expected) => {
    expect(
      enumValues(schema),
      "Changing enum values requires bumping CONTRACT_VERSION.",
    ).toEqual(expected);
  });
});
