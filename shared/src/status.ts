import * as z from "zod/mini";
import { AssetId } from "./identifiers.ts";
import { CoreErrorDetail } from "./errors.ts";
import { NonEmptyString } from "./primitives.ts";

/**
 * Every `explanation` in this file is a display string composed by Core. The
 * consumer renders it as-is and owns any escaping its display context needs;
 * re-deciding the outcome from it is the extension re-implementing resolution.
 *
 * Each one is a `NonEmptyString`: a blank explanation renders as a state the
 * consumer cannot account for, which is the same gap an absent one would leave.
 */

export const RESOLUTION_REASON_KINDS = [
  "included",
  "excluded",
  "overridden",
  "disabled",
  "unavailable",
] as const;
export const ResolutionReasonKind = z.enum(RESOLUTION_REASON_KINDS);
export type ResolutionReasonKind = z.infer<typeof ResolutionReasonKind>;

/**
 * "fallback" is not a value here: falling back is where a degraded resolution
 * landed, not a state an asset is in.
 */
export const AVAILABILITY_STATUSES = ["available", "degraded", "unavailable"] as const;
export const AvailabilityStatus = z.enum(AVAILABILITY_STATUSES);
export type AvailabilityStatus = z.infer<typeof AvailabilityStatus>;

/**
 * `reasons` stays a string array until the reason vocabulary is settled (#3/#9):
 * turning it into an enum later is a breaking change, and an enum invented now
 * would freeze values that no issue defines.
 *
 * Consumed by #9 (availability / degraded / fallback decisions).
 *
 * At least one reason is required: a degraded state whose reason list is empty
 * gives the consumer nothing to display and nothing to distinguish it from a
 * healthy one.
 */
export const DegradedInfo = z.strictObject({
  reasons: z.array(NonEmptyString).check(z.minLength(1)),
});
export type DegradedInfo = z.infer<typeof DegradedInfo>;

const SOFT_CAPABILITY_DEGRADATION_STRENGTHS = ["optional", "preferred"] as const;

/**
 * A `required` degradation always names the fallback that stood in for the
 * capability: a required dependency with no usable fallback is a hard failure
 * (`kind: "unavailable"`), never a degradation. Modelling the strengths as a
 * union is what stops `{ strength: "required" }` alone — a state asserting a
 * required dependency was degraded while naming nothing that satisfied it —
 * from parsing, and publishes the same requirement in the JSON Schema.
 *
 * A soft degradation carries the fallback only when one was selected: an
 * optional or preferred dependency degrades on its own when none exists.
 */
export const CapabilityDegradationDto = z.discriminatedUnion("strength", [
  z.strictObject({
    capabilityId: NonEmptyString,
    strength: z.literal("required"),
    fallbackCapabilityId: NonEmptyString,
  }),
  z.strictObject({
    capabilityId: NonEmptyString,
    strength: z.enum(SOFT_CAPABILITY_DEGRADATION_STRENGTHS),
    fallbackCapabilityId: z.optional(NonEmptyString),
  }),
]);
export type CapabilityDegradationDto = z.infer<typeof CapabilityDegradationDto>;

const REQUIREMENT_FAILURE_CAUSES = [
  "missing_requirement",
  "requirement_out_of_scope",
  "requirement_disabled",
  "requirement_overridden",
  "requirement_cycle",
  "requirement_invalid",
] as const;
const CAPABILITY_FAILURE_CAUSES = ["capability_unavailable", "capability_not_allowed"] as const;

const excludedReasonDetail = z.discriminatedUnion("cause", [
  z.strictObject({
    cause: z.literal("scope_mismatch"),
    matchedAxes: z.array(NonEmptyString),
  }),
  z.strictObject({
    cause: z.literal("invalid_directory"),
    /**
     * At least one diagnostic: this array is the whole account of why the
     * directory selector is invalid, so an empty one excludes the candidate
     * while explaining nothing.
     */
    diagnostics: z.array(CoreErrorDetail).check(z.minLength(1)),
  }),
  z.strictObject({
    cause: z.literal("resolution_conflict"),
    conflict: z.lazy(() => ConflictDto),
  }),
]);

/**
 * Every arm names at least one failed item. An unavailable candidate whose
 * failure list is empty asserts a hard failure while identifying nothing that
 * failed, which leaves the consumer nothing to display and nothing to act on.
 * `failedRequirements` on the capability arm keeps "absent means none": it is
 * omitted rather than sent empty.
 */
const unavailableReasonDetail = z.discriminatedUnion("cause", [
  z.strictObject({
    cause: z.enum(REQUIREMENT_FAILURE_CAUSES),
    failedRequirements: z.array(AssetId).check(z.minLength(1)),
  }),
  z.strictObject({
    cause: z.enum(CAPABILITY_FAILURE_CAUSES),
    failedCapabilities: z.array(NonEmptyString).check(z.minLength(1)),
    failedRequirements: z.optional(z.array(AssetId).check(z.minLength(1))),
  }),
]);

export const ResolutionReason = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("included"),
    explanation: NonEmptyString,
    // `matchedAxes` is unconstrained: a globally scoped asset matches no axis,
    // so the empty array is a real state rather than missing evidence.
    matchedAxes: z.array(NonEmptyString),
    degradedInfo: z.optional(DegradedInfo),
    // Absence already means "no capability degraded", so a present-but-empty
    // list is a second spelling of the same state and nothing else.
    degradedCapabilities: z.optional(z.array(CapabilityDegradationDto).check(z.minLength(1))),
  }),
  z.strictObject({
    kind: z.literal("excluded"),
    explanation: NonEmptyString,
    detail: excludedReasonDetail,
  }),
  z.strictObject({
    kind: z.literal("overridden"),
    explanation: NonEmptyString,
    overriddenBy: AssetId,
    /** Absent for a same-ID overlay: it replaces one identity, not a merge group. */
    mergeGroup: z.optional(NonEmptyString),
  }),
  z.strictObject({
    kind: z.literal("disabled"),
    explanation: NonEmptyString,
    disabledBy: AssetId,
  }),
  z.strictObject({
    kind: z.literal("unavailable"),
    explanation: NonEmptyString,
    availability: z.literal("unavailable"),
    detail: unavailableReasonDetail,
  }),
]);
export type ResolutionReason = z.infer<typeof ResolutionReason>;

export const CONFLICT_KINDS = [
  "exclusive_tie",
  "mandatory_conflict",
  "operation_conflict",
  "duplicate_identity",
  "dependency_cycle",
  "dependency_failure",
  "asset_type_conflict",
  "capability_failure",
] as const;
export const ConflictKind = z.enum(CONFLICT_KINDS);
export type ConflictKind = z.infer<typeof ConflictKind>;

export const ConflictDto = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("exclusive_tie"),
    explanation: NonEmptyString,
    mergeGroup: NonEmptyString,
    involvedAssetIds: z.array(AssetId).check(z.minLength(1)),
  }),
  z.strictObject({
    kind: z.literal("mandatory_conflict"),
    explanation: NonEmptyString,
    involvedAssetIds: z.array(AssetId).check(z.minLength(1)),
  }),
  z.strictObject({
    kind: z.literal("operation_conflict"),
    explanation: NonEmptyString,
    targetAssetId: AssetId,
    involvedAssetIds: z.array(AssetId).check(z.minLength(1)),
  }),
  z.strictObject({
    kind: z.literal("duplicate_identity"),
    explanation: NonEmptyString,
    assetId: AssetId,
    involvedAssetIds: z.array(AssetId).check(z.minLength(1)),
  }),
  z.strictObject({
    kind: z.literal("dependency_cycle"),
    explanation: NonEmptyString,
    involvedAssetIds: z.array(AssetId).check(z.minLength(1)),
  }),
  z.strictObject({
    kind: z.literal("dependency_failure"),
    explanation: NonEmptyString,
    failedRequirement: AssetId,
    involvedAssetIds: z.array(AssetId).check(z.minLength(1)),
  }),
  z.strictObject({
    kind: z.literal("asset_type_conflict"),
    explanation: NonEmptyString,
    involvedAssetIds: z.array(AssetId).check(z.minLength(1)),
  }),
  z.strictObject({
    kind: z.literal("capability_failure"),
    explanation: NonEmptyString,
    failedCapabilities: z.array(NonEmptyString).check(z.minLength(1)),
    involvedAssetIds: z.array(AssetId).check(z.minLength(1)),
  }),
]);
export type ConflictDto = z.infer<typeof ConflictDto>;
