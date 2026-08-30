import { describe, expect, it } from "vitest";
// The .js suffix is required for NodeNext resolution of the TypeScript source.
import {
  parseResolveRequest,
  tryParseResolveRequest,
} from "../src/index.js";

describe("strict boundary objects", () => {
  it("rejects unknown fields at runtime", () => {
    const input = { scope: {}, zzz: true };

    expect(() => parseResolveRequest(input)).toThrow();

    const result = tryParseResolveRequest(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe("invalid_request");
    expect(result.error.details).toEqual([
      expect.objectContaining({
        path: ["zzz"],
        code: "unrecognized_keys",
      }),
    ]);
  });
});
