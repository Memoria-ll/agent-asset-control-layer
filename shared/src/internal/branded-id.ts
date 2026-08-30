import * as z from "zod/mini";

/**
 * Builds the schema for a branded identifier.
 *
 * The brand is type-level only: the parsed value is the input string unchanged
 * and the emitted JSON Schema stays `{"type":"string","minLength":1}`, so a
 * brand never reaches the wire.
 *
 * `zod/mini` has no top-level `z.brand()`; branding is a schema method.
 *
 * This factory stays out of the package index — a consumer able to mint its own
 * identifier types would move the set of identifiers out of this package.
 */
export const brandedId = <Brand extends string>() =>
  z.string().check(z.minLength(1)).brand<Brand>();
