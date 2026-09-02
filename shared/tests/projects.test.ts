import { describe, expect, it } from "vitest";
import {
  PROJECT_DISCOVERY_STATUSES,
  createProjectMarkerDto,
  parseProjectDiscoveryDto,
  parseProjectDiscoveryRequest,
  parseProjectInfoDto,
  parseProjectInitRequest,
  parseProjectMarkerDto,
  tryParseProjectDiscoveryDto,
} from "../src/index.ts";
import { PROJECT_MARKER_SCHEMA_VERSION } from "../src/projects.ts";

describe("Project contracts", () => {
  it("pins the marker shape and schema version", () => {
    expect(PROJECT_MARKER_SCHEMA_VERSION).toBe(1);
    expect(createProjectMarkerDto("project-a")).toEqual({ schemaVersion: 1, projectId: "project-a" });
    expect(parseProjectMarkerDto({ schemaVersion: 1, projectId: "project-a" })).toEqual({
      schemaVersion: 1,
      projectId: "project-a",
    });
    expect(() => parseProjectMarkerDto({ schemaVersion: 2, projectId: "project-a" })).toThrow();
    expect(() => parseProjectMarkerDto({ schemaVersion: 1, projectId: "project-a", extra: true })).toThrow();
  });

  it("validates init, info, and discovery requests", () => {
    expect(parseProjectInitRequest({ projectRoot: "/work/project" })).toEqual({ projectRoot: "/work/project" });
    expect(parseProjectInfoDto({ projectId: "project-a", projectRoot: "/work/project" })).toEqual({
      projectId: "project-a",
      projectRoot: "/work/project",
    });
    expect(parseProjectDiscoveryRequest({ workspacePath: "/work/project/packages/a" })).toEqual({
      workspacePath: "/work/project/packages/a",
    });
  });

  it("accepts exactly the four reachable discovery outcomes", () => {
    expect(PROJECT_DISCOVERY_STATUSES).toEqual([
      "initialized",
      "uninitialized",
      "invalid",
      "mismatch",
    ]);
    const values = [
      {
        status: "initialized",
        workspacePath: "/work/project/packages/a",
        projectRoot: "/work/project",
        projectId: "project-a",
      },
      { status: "uninitialized", workspacePath: "/work/unmanaged" },
      {
        status: "invalid",
        workspacePath: "/work/project",
        projectRoot: "/work/project",
        failure: { code: "invalid_request", message: "Invalid marker." },
      },
      {
        status: "mismatch",
        workspacePath: "/work/project",
        projectRoot: "/work/project",
        markerProjectId: "project-b",
        registryProjectId: "project-a",
      },
    ] as const;

    for (const value of values) expect(parseProjectDiscoveryDto(value)).toEqual(value);
    expect(tryParseProjectDiscoveryDto({
      status: "uninitialized",
      workspacePath: "/work/unmanaged",
      projectRoot: "/not-reachable",
    }).ok).toBe(false);
  });
});
