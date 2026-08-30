import * as z from "zod/mini";
import { NonEmptyString } from "./primitives.js";

/** Coarse classification of a Core API failure. */
export const CORE_ERROR_CODES = [
  "invalid_request",
  "not_found",
  "conflict",
  "unavailable",
  "incompatible_contract",
  "internal",
] as const;
export const CoreErrorCode = z.enum(CORE_ERROR_CODES);
export type CoreErrorCode = z.infer<typeof CoreErrorCode>;

export const CoreErrorDetail = z.strictObject({
  /**
   * Path segments to the offending value. An empty array points at the whole
   * input, and a segment stays an unconstrained string: a JSON object key may
   * legitimately be `""`, and a strict object reports that key like any other.
   */
  path: z.array(z.string()),
  /** Fine-grained code from the origin of the failure (e.g. a zod issue code). */
  code: NonEmptyString,
  message: NonEmptyString,
});
export type CoreErrorDetail = z.infer<typeof CoreErrorDetail>;
export type CoreErrorDetailInput = z.input<typeof CoreErrorDetail>;

/**
 * `message` and `details[].message` are developer-facing English. They are also
 * plain text owned by the consumer for display purposes: this package performs
 * no markup escaping, because it does not know the display context.
 */
export const CoreErrorDto = z.strictObject({
  code: CoreErrorCode,
  message: NonEmptyString,
  /** Omitted when there is nothing to itemise; a present list carries at least one entry. */
  details: z.optional(z.array(CoreErrorDetail).check(z.minLength(1))),
});
export type CoreErrorDto = z.infer<typeof CoreErrorDto>;
export type CoreErrorDtoInput = z.input<typeof CoreErrorDto>;

/** Result of a boundary validation that reports failure instead of throwing. */
export type ParseOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: CoreErrorDto };

/**
 * Which side of an exchange produced the value being validated.
 *
 * Every `tryParse*` entry point declares one. A caller's request and a
 * producer's response fail for different reasons and call for different consumer
 * behaviour — retry the call with corrected input, versus report that the other
 * side broke its own contract — and a single classification cannot express both.
 *
 * It is not exported from the package index: the direction is a property of each
 * named DTO, decided here, not something a consumer supplies.
 */
type BoundaryDirection = "request" | "response";

const VALIDATION_FAILURE: Record<
  BoundaryDirection,
  { code: CoreErrorCode; message: string }
> = {
  request: {
    code: "invalid_request",
    message: "Input does not satisfy the contract schema.",
  },
  response: {
    code: "internal",
    message: "The response does not satisfy the contract schema.",
  },
};

const toDetails = (issue: z.core.$ZodIssue): CoreErrorDetail[] => {
  // Array indices arrive as numbers, and CoreErrorDetail.path is a string array
  // — leaving a number in place makes the error DTO itself fail to parse.
  const path = issue.path.map((segment) => String(segment));

  // An unrecognized_keys issue reports the offending key names in `keys`, not in
  // `path`; `path` only reaches the object that held them. Copying `path` alone
  // drops the key names out of the error entirely, and with every boundary DTO
  // being a strict object this is the most frequent issue at the boundary.
  if (issue.code === "unrecognized_keys") {
    return issue.keys.map((key) => ({
      path: [...path, key],
      code: issue.code,
      message: issue.message,
    }));
  }

  return [{ path, code: issue.code, message: issue.message }];
};

/**
 * Maps a zod validation error onto the boundary error contract.
 *
 * Kept out of the package index alongside `tryParseWith`: its parameter is a
 * `$ZodError`, which `core` and `vscode-extension` cannot construct or narrow
 * without taking the direct zod dependency the boundary forbids them. They reach
 * this mapping through the named `tryParse*` entry points, which take `unknown`
 * and return `CoreErrorDto`.
 */
export const toCoreError = (
  error: z.core.$ZodError,
  direction: BoundaryDirection,
): CoreErrorDto => ({
  code: VALIDATION_FAILURE[direction].code,
  message: VALIDATION_FAILURE[direction].message,
  details: error.issues.flatMap(toDetails),
});

/**
 * Shared body of the `tryParse*` entry points.
 *
 * Kept out of the package index: a published generic parse would let a consumer
 * bring its own schema, which is what naming one function per DTO prevents.
 */
export const tryParseWith = <Schema extends z.core.$ZodType>(
  schema: Schema,
  value: unknown,
  direction: BoundaryDirection,
): ParseOutcome<z.infer<Schema>> => {
  const result = z.safeParse(schema, value);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, error: toCoreError(result.error, direction) };
};

export const parseCoreErrorDto = (value: unknown): CoreErrorDto =>
  z.parse(CoreErrorDto, value);

export const tryParseCoreErrorDto = (value: unknown): ParseOutcome<CoreErrorDto> =>
  tryParseWith(CoreErrorDto, value, "response");
