import * as z from "zod/mini";
import { AssetId } from "./identifiers.js";

/**
 * Every `explanation` in this file is a display string composed by Core. The
 * consumer renders it as-is and owns any escaping its display context needs;
 * re-deciding the outcome from it is the extension re-implementing resolution.
 */

export const ResolutionReasonKind = z.enum([
  "included",
  "excluded",
  "overridden",
  "disabled",
  "unavailable",
]);
export type ResolutionReasonKind = z.infer<typeof ResolutionReasonKind>;

/**
 * "fallback" is not a value here: falling back is where a degraded resolution
 * landed, not a state an asset is in.
 */
export const AvailabilityStatus = z.enum(["available", "degraded", "unavailable"]);
export type AvailabilityStatus = z.infer<typeof AvailabilityStatus>;

/**
 * The availability values that can accompany an `unavailable` resolution reason.
 *
 * `available` is excluded because the pair states two opposite things about one
 * asset, and the consumer has no rule for deciding which half to render. It is a
 * separate enum rather than a check on `AvailabilityStatus` because a check is
 * absent from `z.toJSONSchema` output, which would leave the published schema
 * accepting the very pair the parser rejects.
 */
const UnavailableAvailability = z.enum(["degraded", "unavailable"]);

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
  reasons: z.array(z.string()).check(z.minLength(1)),
});
export type DegradedInfo = z.infer<typeof DegradedInfo>;

/**
 * Why one asset ended up included, excluded, overridden, disabled or
 * unavailable.
 *
 * A discriminated union rather than a flat `{ kind, explanation }`: each arm
 * carries its own references, and a flat shape would push every new field onto
 * consumers of every other arm.
 *
 * The `included` arm deliberately carries no scope-match structure — which
 * scope matched is resolution semantics and belongs to Core (#3).
 */
export const ResolutionReason = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("included"),
    explanation: z.string(),
  }),
  z.strictObject({
    kind: z.literal("excluded"),
    explanation: z.string(),
  }),
  z.strictObject({
    kind: z.literal("overridden"),
    explanation: z.string(),
    overriddenBy: AssetId,
  }),
  z.strictObject({
    kind: z.literal("disabled"),
    explanation: z.string(),
    disabledBy: AssetId,
  }),
  z.strictObject({
    kind: z.literal("unavailable"),
    explanation: z.string(),
    availability: UnavailableAvailability,
  }),
]);
export type ResolutionReason = z.infer<typeof ResolutionReason>;

/** A resolution conflict, reported instead of being silently won by one side. */
export const ConflictDto = z.strictObject({
  explanation: z.string(),
  involvedAssetIds: z.array(AssetId),
});
export type ConflictDto = z.infer<typeof ConflictDto>;
