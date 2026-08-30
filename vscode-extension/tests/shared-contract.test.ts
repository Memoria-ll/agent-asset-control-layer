import { describe, expect, it } from "vitest";
// This consumer intentionally uses no zod import because zod is not its dependency.
import { CONTRACT_VERSION, parseResolveRequest } from "@aacl/shared";

describe("shared contract consumption", () => {
  it("loads the shared contract through the package export", () => {
    const request = parseResolveRequest({
      scope: { projectId: "project-1" },
      loadingTiers: ["core"],
    });

    expect(request.scope.projectId).toBe("project-1");
    expect(request.loadingTiers).toEqual(["core"]);
    expect(CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
