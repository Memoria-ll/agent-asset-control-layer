import * as z from "zod/mini";
import { SemanticVersion } from "./primitives.js";
import { tryParseWith, type ParseOutcome } from "./errors.js";

/**
 * The version of this contract package as a whole. There is no per-category or
 * per-schema version: the only place versions are matched is the connection
 * health check (#32), which needs one bit — can these two sides talk.
 *
 * It moves independently of the repository version in the root `package.json`.
 *
 * Every change to a boundary DTO is breaking, so each one bumps at least MINOR
 * and `checkContractCompatibility` refuses any MAJOR or MINOR mismatch. None of
 * this is readable from the code:
 *   - adding a value to a `z.enum` — an old consumer rejects the new value
 *   - adding a required field to a strict object — an old producer's payload is
 *     rejected
 *   - removing a field, changing a field's type, or making an optional field
 *     required
 *   - adding an arm to a discriminated union
 *   - adding an optional field — an old producer's payload still parses, but
 *     every boundary DTO is a strict object, so an old consumer rejects the new
 *     key
 */
export const CONTRACT_VERSION = "0.1.0";

export const ContractVersion = SemanticVersion;
export type ContractVersion = z.infer<typeof ContractVersion>;

/**
 * What a health/version response carries. The implementation version of Core is
 * deliberately absent: exposing it lets a consumer branch on the implementation
 * instead of on the contract.
 */
export const VersionInfo = z.strictObject({
  contractVersion: SemanticVersion,
});
export type VersionInfo = z.infer<typeof VersionInfo>;
export type VersionInfoInput = z.input<typeof VersionInfo>;

/**
 * The outcome of a version check, as the connection state (#32) renders it.
 *
 * Two values, because the check answers one question: can these two sides talk.
 * A "connect anyway with a warning" state has no receptacle — #32 renders
 * disconnected / incompatible / reconnecting — and `degraded` is the resolution
 * vocabulary in `status.ts`, where it describes an asset rather than a link.
 */
export const CompatibilityStatus = z.enum(["compatible", "incompatible"]);
export type CompatibilityStatus = z.infer<typeof CompatibilityStatus>;

/** `explanation` is a display string; the consumer shows the state rather than failing silently. */
export const CompatibilityResult = z.strictObject({
  status: CompatibilityStatus,
  explanation: z.string(),
});
export type CompatibilityResult = z.infer<typeof CompatibilityResult>;

type VersionParts = { major: number; minor: number };

const toVersionParts = (version: string): VersionParts | undefined => {
  const result = z.safeParse(SemanticVersion, version);
  if (!result.success) {
    return undefined;
  }
  const segments = result.data.split(".");
  return { major: Number(segments[0]), minor: Number(segments[1]) };
};

/**
 * Decides whether two sides holding these contract versions can talk. Both sides
 * run this same function, which is why it lives in the contract package.
 *
 * The two sides talk when MAJOR and MINOR both match; a PATCH difference never
 * affects the outcome.
 *
 * A MINOR difference is breaking whichever side holds the newer number, so the
 * comparison is symmetric rather than directional. Each side both produces and
 * consumes, and every boundary DTO is a strict object: the newer side sends a
 * field added since the older side's version, and the older side rejects the
 * unknown key. Reporting such a pair as usable would let that failure surface
 * later as a parse error on a live exchange instead of at the health check.
 */
export const checkContractCompatibility = (
  local: string,
  remote: string,
): CompatibilityResult => {
  const localParts = toVersionParts(local);
  const remoteParts = toVersionParts(remote);

  if (localParts === undefined || remoteParts === undefined) {
    return {
      status: "incompatible",
      explanation: `Contract version is not a MAJOR.MINOR.PATCH version (local "${local}", remote "${remote}").`,
    };
  }

  if (localParts.major !== remoteParts.major) {
    return {
      status: "incompatible",
      explanation: `Contract major versions differ (local ${local}, remote ${remote}).`,
    };
  }

  if (localParts.minor !== remoteParts.minor) {
    return {
      status: "incompatible",
      explanation: `Contract minor versions differ (local ${local}, remote ${remote}); the side holding the newer version sends fields the other rejects.`,
    };
  }

  return {
    status: "compatible",
    explanation: `Contract versions match (local ${local}, remote ${remote}).`,
  };
};

export const parseVersionInfo = (value: unknown): VersionInfo =>
  z.parse(VersionInfo, value);

export const tryParseVersionInfo = (value: unknown): ParseOutcome<VersionInfo> =>
  tryParseWith(VersionInfo, value, "response");
