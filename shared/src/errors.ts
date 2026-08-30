import * as z from "zod/mini";

/** Coarse classification of a Core API failure. */
export const CoreErrorCode = z.enum([
  "invalid_request",
  "not_found",
  "conflict",
  "unavailable",
  "incompatible_contract",
  "internal",
]);
export type CoreErrorCode = z.infer<typeof CoreErrorCode>;

export const CoreErrorDetail = z.strictObject({
  /** Path segments to the offending value. An empty array points at the whole input. */
  path: z.array(z.string()),
  /** Fine-grained code from the origin of the failure (e.g. a zod issue code). */
  code: z.string(),
  message: z.string(),
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
  message: z.string(),
  details: z.optional(z.array(CoreErrorDetail)),
});
export type CoreErrorDto = z.infer<typeof CoreErrorDto>;
export type CoreErrorDtoInput = z.input<typeof CoreErrorDto>;

/** Result of a boundary validation that reports failure instead of throwing. */
export type ParseOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: CoreErrorDto };

const VALIDATION_FAILURE_MESSAGE = "Input does not satisfy the contract schema.";

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
 * The `$ZodError` itself is never handed to a consumer: `core` and
 * `vscode-extension` do not depend on zod, so a leaked zod type would force
 * that dependency back on them.
 */
export const toCoreError = (error: z.core.$ZodError): CoreErrorDto => ({
  code: "invalid_request",
  message: VALIDATION_FAILURE_MESSAGE,
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
): ParseOutcome<z.infer<Schema>> => {
  const result = z.safeParse(schema, value);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, error: toCoreError(result.error) };
};

export const parseCoreErrorDto = (value: unknown): CoreErrorDto =>
  z.parse(CoreErrorDto, value);

export const tryParseCoreErrorDto = (value: unknown): ParseOutcome<CoreErrorDto> =>
  tryParseWith(CoreErrorDto, value);
