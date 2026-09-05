import { describe, expect, it } from "vitest";
import * as z from "zod/mini";
import {
  ASSET_TYPES,
  AVAILABILITY_STATUSES,
  COMPATIBILITY_STATUSES,
  CONFLICT_KINDS,
  CORE_ERROR_CODES,
  EXECUTION_MODES,
  LOADING_TIERS,
  PROJECT_DISCOVERY_STATUSES,
  RESOLUTION_REASON_KINDS,
  TRANSITION_KINDS,
  BINDING_TARGET_KINDS,
  BINDING_SCOPE_AXES,
  BINDING_CANDIDATE_STATUSES,
  BINDING_REASON_KINDS,
  BINDING_SOURCE_LAYERS,
} from "../src/index.ts";
// The schemas these arrays build are internal; the test reaches them through the
// modules that own them, the way no consumer needs to.
import { CoreErrorCode } from "../src/errors.ts";
import { CompatibilityStatus } from "../src/contract-version.ts";
import { AssetType, ExecutionMode, LoadingTier } from "../src/resolved-context.ts";
import { AvailabilityStatus, ConflictKind, ResolutionReasonKind } from "../src/status.ts";
import { TransitionKind } from "../src/workflow.ts";

describe("frozen contract enum values", () => {
  it.each([
    ["ASSET_TYPES", ASSET_TYPES, ["skill", "rule", "role", "workflow", "task-type", "policy", "guardrail", "knowledge", "binding"]],
    ["RESOLUTION_REASON_KINDS", RESOLUTION_REASON_KINDS, ["included", "excluded", "overridden", "disabled", "unavailable"]],
    ["CONFLICT_KINDS", CONFLICT_KINDS, ["exclusive_tie", "mandatory_conflict", "operation_conflict", "duplicate_identity", "dependency_cycle", "dependency_failure", "asset_type_conflict", "capability_failure"]],
    ["AVAILABILITY_STATUSES", AVAILABILITY_STATUSES, ["available", "degraded", "unavailable"]],
    ["LOADING_TIERS", LOADING_TIERS, ["core", "discoverable", "on-demand"]],
    ["EXECUTION_MODES", EXECUTION_MODES, ["advisory_preparation", "development_execution"]],
    ["CORE_ERROR_CODES", CORE_ERROR_CODES, ["invalid_request", "not_found", "conflict", "unavailable", "incompatible_contract", "internal"]],
    ["COMPATIBILITY_STATUSES", COMPATIBILITY_STATUSES, ["compatible", "incompatible"]],
    ["TRANSITION_KINDS", TRANSITION_KINDS, ["advance", "retry", "reject", "return"]],
    ["PROJECT_DISCOVERY_STATUSES", PROJECT_DISCOVERY_STATUSES, ["initialized", "uninitialized", "invalid", "mismatch"]],
    ["BINDING_TARGET_KINDS", BINDING_TARGET_KINDS, ["provider", "runtime", "model", "runtime-model"]],
    ["BINDING_SCOPE_AXES", BINDING_SCOPE_AXES, ["projectId", "workflowId", "stageId", "taskTypeId", "roleId", "providerId", "runtimeId", "modelId", "directory"]],
    ["BINDING_CANDIDATE_STATUSES", BINDING_CANDIDATE_STATUSES, ["eligible", "unavailable", "fallback"]],
    ["BINDING_REASON_KINDS", BINDING_REASON_KINDS, ["eligible", "scope_mismatch", "binding_disabled", "binding_overridden", "target_missing", "target_provider_mismatch", "capability_unavailable", "capability_not_allowed", "requirement_unavailable", "fallback_not_needed", "fallback_primary_unavailable", "invalid_binding"]],
    ["BINDING_SOURCE_LAYERS", BINDING_SOURCE_LAYERS, ["global", "personal", "project"]],
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
    ["ConflictKind", ConflictKind, CONFLICT_KINDS],
    ["AvailabilityStatus", AvailabilityStatus, AVAILABILITY_STATUSES],
    ["LoadingTier", LoadingTier, LOADING_TIERS],
    ["ExecutionMode", ExecutionMode, EXECUTION_MODES],
    ["CoreErrorCode", CoreErrorCode, CORE_ERROR_CODES],
    ["CompatibilityStatus", CompatibilityStatus, COMPATIBILITY_STATUSES],
    ["TransitionKind", TransitionKind, TRANSITION_KINDS],
  ])("accepts exactly the published members of %s", (_name, schema, members) => {
    for (const member of members) {
      expect(z.safeParse(schema, member).success, member).toBe(true);
    }
    expect(z.safeParse(schema, "not-a-member").success).toBe(false);
  });
});
