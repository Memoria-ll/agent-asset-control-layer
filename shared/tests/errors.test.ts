import * as z from "zod/mini";
import { describe, expect, it } from "vitest";
import * as shared from "../src/index.ts";
import {
  parseCoreErrorDto,
  tryParseResolveRequest,
  tryParseResolveResponse,
} from "../src/index.ts";
// The schema value is internal; this test needs it to produce a real $ZodError.
import { ResolveRequest } from "../src/resolution.ts";
// toCoreError takes a $ZodError, so it is deliberately absent from the
// package index; this test reaches it through the module that owns it.
import { toCoreError, type ParseOutcome } from "../src/errors.ts";

const validationErrorFor = (value: unknown): z.core.$ZodError => {
  const result = z.safeParse(ResolveRequest, value);
  if (result.success) throw new Error("Expected validation to fail");
  return result.error;
};

describe("Core error mapping", () => {
  it("preserves every unknown top-level key as a detail", () => {
    const error = toCoreError(
      validationErrorFor({ scope: {}, zzz: 1, yyy: 2 }),
      "request",
    );

    expect(error.details).toEqual([
      expect.objectContaining({ path: ["zzz"], code: "unrecognized_keys" }),
      expect.objectContaining({ path: ["yyy"], code: "unrecognized_keys" }),
    ]);
    expect(error.details).toHaveLength(2);
    expect(parseCoreErrorDto(error)).toEqual(error);
  });

  it("includes the path to an unknown nested key", () => {
    const error = toCoreError(validationErrorFor({ scope: { zz: 1 } }), "request");

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
      "request",
    );

    expect(error.details).toEqual([
      expect.objectContaining({ path: ["loadingTiers", "1"], code: "invalid_value" }),
    ]);
    expect(parseCoreErrorDto(error)).toEqual(error);
  });
});

/**
 * The parsers whose input is composed by the caller. Every other `tryParse*`
 * validates something Core produced, so a failure there is the producer
 * breaking its own contract rather than a bad request.
 */
const REQUEST_PARSERS = new Set([
  "tryParseResolveRequest",
  "tryParseProjectInitRequest",
  "tryParseProjectDiscoveryRequest",
]);

describe("boundary direction decides the failure code", () => {
  const parsers = Object.entries(shared).filter(
    ([name, value]) => name.startsWith("tryParse") && typeof value === "function",
  ) as [string, (value: unknown) => ParseOutcome<unknown>][];

  it("classifies every published parser", () => {
    expect(parsers.length).toBeGreaterThan(0);

    for (const [name, parse] of parsers) {
      const outcome = parse(null);
      if (outcome.ok) throw new Error(`Expected ${name} to reject null`);

      expect(outcome.error.code, name).toBe(
        REQUEST_PARSERS.has(name) ? "invalid_request" : "internal",
      );
    }
  });

  it("keeps a malformed response distinguishable from a bad request", () => {
    const request = tryParseResolveRequest({ scope: {}, zzz: 1 });
    const response = tryParseResolveResponse({ resolvedContext: {}, zzz: 1 });

    if (request.ok || response.ok) throw new Error("Expected both to fail");
    expect(request.error.code).toBe("invalid_request");
    expect(response.error.code).toBe("internal");
    expect(request.error.message).not.toBe(response.error.message);
  });
});
