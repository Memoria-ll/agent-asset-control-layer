import * as z from "zod/mini";

/** Basis for identifiers and display names. */
export const NonEmptyString = z.string().check(z.minLength(1));
export type NonEmptyString = z.infer<typeof NonEmptyString>;

/**
 * ISO 8601 date-time that carries a UTC offset.
 *
 * `{ offset: true }` is required: without it `2026-08-30T01:02:03+09:00` is
 * rejected and only `Z` is accepted. `z.date()` is not usable at the boundary
 * at all — `z.toJSONSchema` throws "Date cannot be represented in JSON Schema".
 */
export const Timestamp = z.iso.datetime({ offset: true });
export type Timestamp = z.infer<typeof Timestamp>;

/** Token estimate. Consumed by #10 (loading tiers) and #37 (context cost). */
export const TokenCount = z.int().check(z.gte(0));
export type TokenCount = z.infer<typeof TokenCount>;

/**
 * A filesystem path crossing the boundary.
 *
 * Separator style, absolute vs relative, and the Windows/WSL representation
 * difference are deliberately unconstrained here: which representation travels
 * is decided by the connection boundary (#32) and the IDE context source (#36).
 */
export const DirectoryPath = NonEmptyString;
export type DirectoryPath = z.infer<typeof DirectoryPath>;

/**
 * `MAJOR.MINOR.PATCH` with no pre-release or build metadata.
 *
 * `checkContractCompatibility` compares major and minor only, and a pre-release
 * suffix would need a precedence rule of its own before it could be accepted.
 */
export const SemanticVersion = z
  .string()
  .check(z.regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/));
export type SemanticVersion = z.infer<typeof SemanticVersion>;
