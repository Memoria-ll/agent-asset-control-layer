import { describe, expect, it } from "vitest";
// The package specifier exercises the exports map; a relative path would bypass it.
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
