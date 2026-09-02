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
    expect(() => parseProjectMarkerDto({ schemaVersion: 1, projectId: "INVALID" })).toThrow();
    expect(() => parseProjectMarkerDto({ schemaVersion: 1, projectId: `project-${"a".repeat(121)}` })).toThrow();
  });

  it("validates init, info, and discovery requests", () => {
    expect(parseProjectInitRequest({ projectRoot: "/work/project" })).toEqual({ projectRoot: "/work/project" });
    expect(parseProjectInfoDto({ projectId: "project-a", projectRoot: "/work/project" })).toEqual({
      projectId: "project-a",
      projectRoot: "/work/project",
    });
    expect(() => parseProjectInfoDto({ projectId: "PROJECT-A", projectRoot: "/work/project" })).toThrow();
    expect(() => parseProjectInfoDto({ projectId: `project-${"a".repeat(121)}`, projectRoot: "/work/project" })).toThrow();
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
    expect(parseProjectDiscoveryDto({
      status: "invalid",
      workspacePath: "/work/project",
      projectRoot: "/work/project",
      failure: { code: "unavailable", message: "The marker could not be read." },
    })).toMatchObject({ status: "invalid" });
    expect(() => parseProjectDiscoveryDto({
      status: "invalid",
      workspacePath: "/work/project",
      projectRoot: "/work/project",
      failure: { code: "internal", message: "Unexpected failure." },
    })).toThrow();
    expect(() => parseProjectDiscoveryDto({
      status: "initialized",
      workspacePath: "/work/project/packages/a",
      projectRoot: "/work/project",
      projectId: "PROJECT-A",
    })).toThrow();
    expect(() => parseProjectDiscoveryDto({
      status: "mismatch",
      workspacePath: "/work/project",
      projectRoot: "/work/project",
      markerProjectId: "PROJECT-B",
      registryProjectId: "project-a",
    })).toThrow();
    expect(() => parseProjectDiscoveryDto({
      status: "mismatch",
      workspacePath: "/work/project",
      projectRoot: "/work/project",
      markerProjectId: "project-b",
      registryProjectId: "PROJECT-A",
    })).toThrow();
    expect(tryParseProjectDiscoveryDto({
      status: "uninitialized",
      workspacePath: "/work/unmanaged",
      projectRoot: "/not-reachable",
    }).ok).toBe(false);
  });
});
