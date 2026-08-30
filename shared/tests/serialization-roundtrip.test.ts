import * as z from "zod/mini";
import { describe, expect, it } from "vitest";
import { contractSchemas, parseResolveRequest } from "../src/index.js";

const representativeInputs: Record<string, unknown> = {
  ResolveRequest: {
    scope: { projectId: "project-1", directory: "/workspace" },
    ide: {
      workspaceFolder: "/workspace",
      activeFilePath: "/workspace/readme.md",
      selectedFilePaths: ["/workspace/readme.md"],
    },
    loadingTiers: ["core", "discoverable", "on-demand"],
  },
  ResolveResponse: {
    resolvedContext: {
      scope: { projectId: "project-1" },
      assets: [
        {
          assetId: "asset-1",
          revision: "revision-1",
          assetType: "skill",
          loadingTier: "core",
          reason: { kind: "included", explanation: "Matched scope" },
          body: "# Example",
          tokenEstimate: 12,
        },
      ],
      conflicts: [
        { explanation: "Overlapping assets", involvedAssetIds: ["asset-1"] },
      ],
      cost: { totalTokenEstimate: 12, includedAssetCount: 1, excludedAssetCount: 0 },
      resolvedAt: "2026-08-30T01:02:03+09:00",
    },
  },
  ResolvedContextDto: {
    scope: { projectId: "project-1" },
    assets: [],
    conflicts: [],
    cost: { totalTokenEstimate: 0, includedAssetCount: 0, excludedAssetCount: 0 },
    resolvedAt: "2026-08-30T01:02:03+09:00",
  },
  SessionDto: {
    sessionId: "session-1",
    createdAt: "2026-08-30T01:02:03+09:00",
    updatedAt: "2026-08-30T01:02:03+09:00",
    projectId: "project-1",
    agentExecutionIds: [],
    snapshotIds: [],
  },
  AgentExecutionDto: {
    agentExecutionId: "execution-1",
    sessionId: "session-1",
    projectId: "project-1",
    workflowId: "workflow-1",
    stageId: "stage-1",
    taskTypeId: "task-type-1",
    roleId: "role-1",
    providerId: "provider-1",
    runtimeId: "runtime-1",
    modelId: "model-1",
    startedAt: "2026-08-30T01:02:03+09:00",
    endedAt: "2026-08-30T01:03:03+09:00",
    snapshotId: "snapshot-1",
  },
  WorkflowStateDto: {
    workflowId: "workflow-1",
    currentStageId: "stage-1",
    entryRoleId: "role-1",
    currentRoleId: "role-1",
    linkedAgentExecutionIds: ["execution-1"],
    linkedSnapshotIds: ["snapshot-1"],
    updatedAt: "2026-08-30T01:02:03+09:00",
  },
  TransitionCandidateDto: {
    toStageId: "stage-2",
    requiredRoleId: "role-1",
    requiredTaskTypeId: "task-type-1",
    blocked: false,
    blockedReasons: [],
  },
  VersionInfo: { contractVersion: "0.1.0" },
  CoreErrorDto: {
    code: "invalid_request",
    message: "Input does not satisfy the contract schema.",
    details: [{ path: ["scope"], code: "invalid_type", message: "Invalid input" }],
  },
  ProviderDto: { providerId: "provider-1", displayName: "Provider" },
  RuntimeDto: {
    runtimeId: "runtime-1",
    displayName: "Runtime",
    providerId: "provider-1",
  },
  ModelDto: {
    modelId: "model-1",
    displayName: "Model",
    providerId: "provider-1",
  },
  RoleDto: { roleId: "role-1", displayName: "Role" },
  TaskTypeDto: { taskTypeId: "task-type-1", displayName: "Task type" },
};

describe("contract serialization", () => {
  it("round-trips a representative input for every registered schema", () => {
    for (const [name, schema] of Object.entries(contractSchemas)) {
      const parsed = z.parse(schema, representativeInputs[name]);
      const serialized = JSON.stringify(parsed);
      if (serialized === undefined) throw new Error(`No JSON value for ${name}`);
      const roundTripped = z.parse(schema, JSON.parse(serialized));

      expect(roundTripped, name).toEqual(parsed);
    }
  });

  it("normalizes omitted and explicitly undefined optional fields after JSON", () => {
    const omitted = parseResolveRequest({ scope: {} });
    const explicitUndefined = parseResolveRequest({ scope: {}, ide: undefined });

    expect(Object.keys(omitted)).toEqual(["scope"]);
    expect(Object.keys(explicitUndefined)).toEqual(["scope", "ide"]);
    expect(Object.prototype.hasOwnProperty.call(omitted, "ide")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(explicitUndefined, "ide")).toBe(true);

    const omittedAfterJson = JSON.parse(JSON.stringify(omitted));
    const explicitAfterJson = JSON.parse(JSON.stringify(explicitUndefined));
    expect(Object.keys(omittedAfterJson)).toEqual(["scope"]);
    expect(Object.keys(explicitAfterJson)).toEqual(["scope"]);
    expect(explicitAfterJson).toEqual(omittedAfterJson);
  });
});
