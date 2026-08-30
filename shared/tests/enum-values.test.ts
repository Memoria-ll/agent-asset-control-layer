import { describe, expect, it } from "vitest";
import * as z from "zod/mini";
import {
  ASSET_TYPES,
  AVAILABILITY_STATUSES,
  COMPATIBILITY_STATUSES,
  CORE_ERROR_CODES,
  LOADING_TIERS,
  RESOLUTION_REASON_KINDS,
} from "../src/index.js";
// The schemas these arrays build are internal; the test reaches them through the
// modules that own them, the way no consumer needs to.
import { CoreErrorCode } from "../src/errors.js";
import { CompatibilityStatus } from "../src/contract-version.js";
import { AssetType, LoadingTier } from "../src/resolved-context.js";
import { AvailabilityStatus, ResolutionReasonKind } from "../src/status.js";

describe("frozen contract enum values", () => {
  it.each([
    ["ASSET_TYPES", ASSET_TYPES, ["skill", "rule", "role", "workflow", "task-type", "policy", "guardrail", "knowledge"]],
    ["RESOLUTION_REASON_KINDS", RESOLUTION_REASON_KINDS, ["included", "excluded", "overridden", "disabled", "unavailable"]],
    ["AVAILABILITY_STATUSES", AVAILABILITY_STATUSES, ["available", "degraded", "unavailable"]],
    ["LOADING_TIERS", LOADING_TIERS, ["core", "discoverable", "on-demand"]],
    ["CORE_ERROR_CODES", CORE_ERROR_CODES, ["invalid_request", "not_found", "conflict", "unavailable", "incompatible_contract", "internal"]],
    ["COMPATIBILITY_STATUSES", COMPATIBILITY_STATUSES, ["compatible", "incompatible"]],
  ])("keeps %s stable", (_name, members, expected) => {
    expect(
      [...members],
      "Changing enum values requires bumping CONTRACT_VERSION.",
    ).toEqual(expected);
  });

  /**
   * The published array and the schema built from it cannot drift, because the
   * array is what the schema is built from. This pins that wiring: a schema
   * rebuilt from a hand-written list instead would pass the table above and fail
   * here.
   */
  it.each([
    ["AssetType", AssetType, ASSET_TYPES],
    ["ResolutionReasonKind", ResolutionReasonKind, RESOLUTION_REASON_KINDS],
    ["AvailabilityStatus", AvailabilityStatus, AVAILABILITY_STATUSES],
    ["LoadingTier", LoadingTier, LOADING_TIERS],
    ["CoreErrorCode", CoreErrorCode, CORE_ERROR_CODES],
    ["CompatibilityStatus", CompatibilityStatus, COMPATIBILITY_STATUSES],
  ])("accepts exactly the published members of %s", (_name, schema, members) => {
    for (const member of members) {
      expect(z.safeParse(schema, member).success, member).toBe(true);
    }
    expect(z.safeParse(schema, "not-a-member").success).toBe(false);
  });
});
