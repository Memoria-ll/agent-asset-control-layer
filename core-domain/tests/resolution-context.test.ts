import { describe, expect, it } from "vitest";
import { parseResolveRequest } from "@aacl/shared";
import { toResolutionContext } from "../src/index.ts";

describe("resolution context", () => {
  it("keeps agent execution out of the resolution scope", () => {
    const request = parseResolveRequest({
      scope: { roleId: "reviewer", modelId: "claude-opus-5" },
    });
    const result = toResolutionContext(request.scope);

    expect(result).toEqual({
      ok: true,
      value: { roleId: "reviewer", modelId: "claude-opus-5" },
    });
    if (result.ok) {
      expect(Object.keys(result.value)).toEqual(["roleId", "modelId"]);
      expect("agentExecutionId" in result.value).toBe(false);
    }

    const scopeWithExecution = {
      roleId: "reviewer",
      agentExecutionId: "exec-1",
    } as Parameters<typeof toResolutionContext>[0];
    const invalid = toResolutionContext(scopeWithExecution);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.failure.details?.[0]?.code).toBe("unknown_key");
    }
    expect(() => parseResolveRequest({ scope: scopeWithExecution })).toThrow();
  });

  it("rejects an empty resolution identifier", () => {
    const result = toResolutionContext({ roleId: "" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("invalid_request");
      expect(result.failure.details?.[0]?.code).toBe("empty_identifier");
    }
  });

  it("normalizes trailing slashes on a directory scope", () => {
    const result = toResolutionContext({ directory: "/repo/src/" });

    expect(result).toEqual({ ok: true, value: { directory: "/repo/src" } });
  });

  it.each(["\\repo\\src", "C:/repo", "repo/src", "/repo/./src", "/repo/../src"])(
    "rejects an invalid directory scope %s",
    (directory) => {
      const result = toResolutionContext({ directory });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.code).toBe("invalid_request");
        expect(result.failure.details?.[0]?.code).toBe("invalid_directory");
      }
    },
  );
});
