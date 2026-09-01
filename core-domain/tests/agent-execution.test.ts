import { describe, expect, it } from "vitest";
import { parseAgentExecutionDto, type ModelId, type ProviderId, type RoleId, type RuntimeId, type TaskTypeId } from "@aacl/shared";
import {
  agentExecutionScope,
  buildMetadataCatalog,
  toAgentExecutionDto,
  validateAgentExecutionReferences,
  type AgentExecutionRecord,
  type CatalogRevision,
} from "../src/index.ts";

const parsedExecution = parseAgentExecutionDto({
  agentExecutionId: "execution-1",
  sessionId: "session-1",
  projectId: "project-1",
  workflowId: "workflow-1",
  stageId: "stage-1",
  taskTypeId: "code-review",
  roleId: "reviewer",
  providerId: "anthropic",
  runtimeId: "claude-code",
  modelId: "claude-opus-5",
  startedAt: "2026-08-30T01:02:03+09:00",
  endedAt: "2026-08-30T01:12:03+09:00",
  snapshotId: "snapshot-1",
});

// The DTO types every optional field as `T | undefined`, which exactOptionalPropertyTypes
// refuses to assign to the record's `T?`, so the record cannot be a wholesale spread. The
// fixture supplies all thirteen fields; the guard narrows them and pins that contract, and
// every value still comes from the real parser rather than a hand-written literal.
const {
  sessionId, projectId, workflowId, stageId, taskTypeId, roleId,
  providerId, runtimeId, modelId, endedAt, snapshotId,
} = parsedExecution;

if (
  sessionId === undefined || projectId === undefined || workflowId === undefined ||
  stageId === undefined || taskTypeId === undefined || roleId === undefined ||
  providerId === undefined || runtimeId === undefined || modelId === undefined ||
  endedAt === undefined || snapshotId === undefined
) {
  throw new Error("The fixture must supply every optional execution field.");
}

const executionRecord: AgentExecutionRecord = {
  agentExecutionId: parsedExecution.agentExecutionId,
  startedAt: parsedExecution.startedAt,
  sessionId, projectId, workflowId, stageId, taskTypeId, roleId,
  providerId, runtimeId, modelId, endedAt, snapshotId,
};

describe("agent execution domain", () => {
  it("projects only static catalog axes into an asset scope", () => {
    const scope = agentExecutionScope(executionRecord);

    expect(Object.keys(scope)).toEqual([
      "projectId",
      "workflowId",
      "stageId",
      "taskTypeId",
      "roleId",
      "providerId",
      "runtimeId",
      "modelId",
    ]);
    expect(scope).toEqual({
      projectId: "project-1",
      workflowId: "workflow-1",
      stageId: "stage-1",
      taskTypeId: "code-review",
      roleId: "reviewer",
      providerId: "anthropic",
      runtimeId: "claude-code",
      modelId: "claude-opus-5",
    });
    for (const key of ["agentExecutionId", "sessionId", "snapshotId", "startedAt", "endedAt"]) {
      expect(key in scope).toBe(false);
    }
  });

  it("round-trips a complete execution and rejects a record without startedAt", () => {
    const result = toAgentExecutionDto(executionRecord);

    expect(result).toEqual({ ok: true, value: parsedExecution });
    if (result.ok) expect(parseAgentExecutionDto(result.value)).toEqual(parsedExecution);

    const { startedAt: _startedAt, ...recordWithoutStartedAt } = executionRecord;
    const missingStartedAt = toAgentExecutionDto(recordWithoutStartedAt);
    expect(missingStartedAt.ok).toBe(false);
    if (!missingStartedAt.ok) {
      expect(missingStartedAt.failure.code).toBe("invalid_request");
      expect(missingStartedAt.failure.details?.[0]?.code).toBe("missing_field");
      expect(missingStartedAt.failure.details?.[0]?.path).toEqual(["record", "startedAt"]);
    }
  });

  it("rejects provider ownership mismatches for referenced runtime and model", () => {
    const catalogResult = buildMetadataCatalog({
      revision: "test" as CatalogRevision,
      roles: [{ roleId: "reviewer" as RoleId, displayName: "Reviewer" }],
      taskTypes: [{ taskTypeId: "code-review" as TaskTypeId, displayName: "Code review" }],
      providers: [
        { providerId: "anthropic" as ProviderId, displayName: "Anthropic" },
        { providerId: "openai" as ProviderId, displayName: "OpenAI" },
      ],
      runtimes: [{ runtimeId: "claude-code" as RuntimeId, displayName: "Claude Code", providerId: "anthropic" as ProviderId }],
      models: [{ modelId: "claude-opus-5" as ModelId, displayName: "Claude Opus 5", providerId: "anthropic" as ProviderId }],
      roleModelRelations: [],
    });
    if (!catalogResult.ok) throw new Error(catalogResult.failure.message);

    const result = validateAgentExecutionReferences(catalogResult.value, {
      ...executionRecord,
      providerId: "openai" as ProviderId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.details?.map((item) => ({ path: item.path, code: item.code }))).toEqual([
        { path: ["record", "runtimeId"], code: "runtime_provider_mismatch" },
        { path: ["record", "modelId"], code: "model_provider_mismatch" },
      ]);
    }
  });

  it("rejects invalid timestamps before DTO projection succeeds", () => {
    const invalidStartedAt = toAgentExecutionDto({
      ...executionRecord,
      startedAt: "yesterday",
    } as AgentExecutionRecord);
    expect(invalidStartedAt.ok).toBe(false);
    if (!invalidStartedAt.ok) {
      expect(invalidStartedAt.failure.code).toBe("invalid_request");
      expect(invalidStartedAt.failure.details?.some((item) => item.path.join(".") === "startedAt")).toBe(true);
    }

    const invalidEndedAt = toAgentExecutionDto({
      ...executionRecord,
      endedAt: "tomorrow",
    } as AgentExecutionRecord);
    expect(invalidEndedAt.ok).toBe(false);
    if (!invalidEndedAt.ok) {
      expect(invalidEndedAt.failure.code).toBe("invalid_request");
      expect(invalidEndedAt.failure.details?.some((item) => item.path.join(".") === "endedAt")).toBe(true);
    }
  });
});
