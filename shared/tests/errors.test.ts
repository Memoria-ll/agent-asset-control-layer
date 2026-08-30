import * as z from "zod/mini";
import { describe, expect, it } from "vitest";
import {
  ResolveRequest,
  parseCoreErrorDto,
  toCoreError,
} from "../src/index.js";

const validationErrorFor = (value: unknown): z.core.$ZodError => {
  const result = z.safeParse(ResolveRequest, value);
  if (result.success) throw new Error("Expected validation to fail");
  return result.error;
};

describe("Core error mapping", () => {
  it("preserves every unknown top-level key as a detail", () => {
    const error = toCoreError(
      validationErrorFor({ scope: {}, zzz: 1, yyy: 2 }),
    );

    expect(error.details).toEqual([
      expect.objectContaining({ path: ["zzz"], code: "unrecognized_keys" }),
      expect.objectContaining({ path: ["yyy"], code: "unrecognized_keys" }),
    ]);
    expect(error.details).toHaveLength(2);
    expect(parseCoreErrorDto(error)).toEqual(error);
  });

  it("includes the path to an unknown nested key", () => {
    const error = toCoreError(validationErrorFor({ scope: { zz: 1 } }));

    expect(error.details).toEqual([
      expect.objectContaining({
        path: ["scope", "zz"],
        code: "unrecognized_keys",
      }),
    ]);
    expect(parseCoreErrorDto(error)).toEqual(error);
  });

  it("serializes array indices as strings in details", () => {
    const error = toCoreError(
      validationErrorFor({ scope: {}, loadingTiers: ["core", 123] }),
    );

    expect(error.details).toEqual([
      expect.objectContaining({ path: ["loadingTiers", "1"], code: "invalid_value" }),
    ]);
    expect(parseCoreErrorDto(error)).toEqual(error);
  });
});
