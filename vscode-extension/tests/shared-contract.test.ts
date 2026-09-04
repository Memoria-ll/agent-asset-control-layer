import { describe, expect, it } from "vitest";
// This consumer intentionally uses no zod import because zod is not its dependency.
import {
  CONTRACT_VERSION,
  parseProjectDiscoveryRequest,
  parseProjectInitRequest,
  parseResolveRequest,
} from "@aacl/shared";
import type { ProjectClient } from "../src/index.ts";

describe("shared contract consumption", () => {
  it("loads the shared contract through the package export", () => {
    const request = parseResolveRequest({
      context: {
        executionMode: "advisory_preparation",
        workflow: { kind: "none" },
        projectId: "project-1",
      },
      loadingTiers: ["core"],
    });

    expect(request.context.projectId).toBe("project-1");
    expect(request.loadingTiers).toEqual(["core"]);
    expect(CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("uses the shared Project Init and discovery operation boundary", () => {
    const init: Parameters<ProjectClient["initialize"]>[0] = parseProjectInitRequest({
      projectRoot: "/workspace/packages/app",
    });
    const discovery: Parameters<ProjectClient["discover"]>[0] = parseProjectDiscoveryRequest({
      workspacePath: "/workspace/packages/app/src",
    });

    expect(init.projectRoot).toBe("/workspace/packages/app");
    expect(discovery.workspacePath).toBe("/workspace/packages/app/src");
  });
});
