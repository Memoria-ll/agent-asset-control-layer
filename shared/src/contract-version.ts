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
 * Operations that require a MAJOR bump (a MINOR bump while MAJOR is 0, which is
 * treated as breaking here). None of this is readable from the code:
 *   - adding a value to a `z.enum` — an old consumer rejects the new value
 *   - adding a required field to a strict object — an old producer's payload is
 *     rejected
 *   - removing a field, changing a field's type, or making an optional field
 *     required
 *   - adding an arm to a discriminated union
 * Adding an optional field is non-breaking for an old producer, but every
 * boundary DTO is a strict object, so an old consumer still rejects it: a new
 * producer reaching an old consumer is breaking even then.
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

export const CompatibilityStatus = z.enum([
  "compatible",
  "degraded",
  "incompatible",
]);
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
 * A patch difference never affects the outcome. While MAJOR is 0 a MINOR
 * difference is incompatible, following the 0.x reading that anything may
 * change: connecting anyway would let a mismatch pass unannounced.
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

  if (localParts.major === 0) {
    return localParts.minor === remoteParts.minor
      ? {
          status: "compatible",
          explanation: `Contract versions match (local ${local}, remote ${remote}).`,
        }
      : {
          status: "incompatible",
          explanation: `Contract minor versions differ below 1.0.0, where a minor change is breaking (local ${local}, remote ${remote}).`,
        };
  }

  if (remoteParts.minor < localParts.minor) {
    return {
      status: "degraded",
      explanation: `The remote contract is older (local ${local}, remote ${remote}); fields added since the remote minor version are absent.`,
    };
  }

  return {
    status: "compatible",
    explanation: `Contract versions are compatible (local ${local}, remote ${remote}).`,
  };
};

export const parseVersionInfo = (value: unknown): VersionInfo =>
  z.parse(VersionInfo, value);

export const tryParseVersionInfo = (value: unknown): ParseOutcome<VersionInfo> =>
  tryParseWith(VersionInfo, value);
