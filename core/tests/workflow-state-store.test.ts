import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeWorkflowState, type AssetResult, type WorkflowStateMutation, type WorkflowStateSeed } from "@aacl/core-domain";
import type { AgentExecutionId, ExecutionInstanceId, RoleId, SnapshotId, StageId, Timestamp, WorkflowId, WorkflowStateVersion } from "@aacl/shared";
import { createWorkflowStateStore, type WorkflowStateStore } from "../src/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "aacl-workflow-state-"));
  temporaryDirectories.push(directory);
  return directory;
};

const unwrap = <Value>(result: AssetResult<Value>): Value => {
  if (!result.ok) throw new Error(result.failure.message);
  return result.value;
};

const seed = (workflowId = "review-flow" as WorkflowId): WorkflowStateSeed => ({
  workflowId,
  currentStageId: "start" as StageId,
  entryRoleId: "reviewer" as RoleId,
  currentRoleId: "reviewer" as RoleId,
  linkedAgentExecutionIds: ["agent-1" as AgentExecutionId],
  linkedSnapshotIds: ["snapshot-1" as SnapshotId],
});

const mutation = (state: { readonly workflowId: WorkflowId; readonly executionInstanceId: ExecutionInstanceId; readonly stateVersion: number }, agentId: string, version = state.stateVersion + 1): WorkflowStateMutation => ({
  workflowId: state.workflowId,
  executionInstanceId: state.executionInstanceId,
  stateVersion: version as WorkflowStateVersion,
  currentStageId: "done" as StageId,
  entryRoleId: "reviewer" as RoleId,
  currentRoleId: "reviewer" as RoleId,
  linkedAgentExecutionIds: [agentId as AgentExecutionId],
  linkedSnapshotIds: ["snapshot-2" as SnapshotId],
});

const createStore = async (options: { readonly stateDirectory: string; readonly now?: () => Timestamp; readonly generateExecutionInstanceId?: () => ExecutionInstanceId; readonly rename?: (from: string, to: string) => Promise<void> }): Promise<WorkflowStateStore> =>
  unwrap(await createWorkflowStateStore(options));

describe("filesystem workflow state store", () => {
  it("creates, reads, CAS-updates, and preserves the existing mode", async () => {
    const directory = await temporaryDirectory();
    const times = ["2026-09-01T10:00:00Z", "2026-09-01T10:01:00Z"] as Timestamp[];
    let nowCalls = 0;
    const store = await createStore({
      stateDirectory: directory,
      now: () => times[nowCalls++] as Timestamp,
      generateExecutionInstanceId: () => "instance-one" as ExecutionInstanceId,
    });
    const created = unwrap(await store.create(seed()));
    const target = join(directory, "workflows", "instance-one.json");
    expect(created.stateVersion).toBe(0);
    expect(created.updatedAt).toBe(times[0]);
    expect((await stat(target)).mode & 0o777).toBe(0o600);

    await chmod(target, 0o640);
    const before = await readFile(target);
    const updated = unwrap(await store.compareAndSwap(created.workflowId, created.executionInstanceId, 0 as never, mutation(created, "agent-2")));
    expect(updated.stateVersion).toBe(1);
    expect(updated.updatedAt).toBe(times[1]);
    expect((await stat(target)).mode & 0o777).toBe(0o640);
    expect(await store.get(created.workflowId, created.executionInstanceId)).toMatchObject({ ok: true, value: updated });
    expect(await readFile(target)).not.toBe(before);
    expect(nowCalls).toBe(2);
  });

  it("serializes factories sharing a lexical state directory and handles an id collision without overwrite", async () => {
    const directory = await temporaryDirectory();
    let sequence = 0;
    const first = await createStore({ stateDirectory: directory, now: () => "2026-09-01T10:00:00Z" as Timestamp, generateExecutionInstanceId: () => "instance-existing" as ExecutionInstanceId });
    const original = unwrap(await first.create(seed()));
    const second = await createStore({
      stateDirectory: directory,
      now: () => "2026-09-01T10:00:01Z" as Timestamp,
      generateExecutionInstanceId: () => (sequence++ === 0 ? "instance-existing" : "instance-new") as ExecutionInstanceId,
    });
    const created = unwrap(await second.create(seed("second-flow" as WorkflowId)));
    expect(created.executionInstanceId).toBe("instance-new");
    expect(unwrap(await first.get(original.workflowId, original.executionInstanceId)).workflowId).toBe("review-flow");
    expect((await readdir(join(directory, "workflows"))).sort()).toEqual(["instance-existing.json", "instance-new.json"]);
  });

  it("allows only one concurrent stale CAS and leaves the loser links untouched", async () => {
    const directory = await temporaryDirectory();
    const store = await createStore({ stateDirectory: directory, now: () => "2026-09-01T10:00:00Z" as Timestamp, generateExecutionInstanceId: () => "instance-one" as ExecutionInstanceId });
    const created = unwrap(await store.create(seed()));
    const results = await Promise.all([
      store.compareAndSwap(created.workflowId, created.executionInstanceId, 0 as never, mutation(created, "winner-a")),
      store.compareAndSwap(created.workflowId, created.executionInstanceId, 0 as never, mutation(created, "winner-b")),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.failure.code === "conflict")).toHaveLength(1);
    const final = unwrap(await store.get(created.workflowId, created.executionInstanceId));
    expect(final.stateVersion).toBe(1);
    expect(["winner-a", "winner-b"]).toContain(final.linkedAgentExecutionIds[0]);
  });

  it("does not update, rename, or consume now for stale or invalid CAS", async () => {
    const directory = await temporaryDirectory();
    let nowCalls = 0;
    let renameCalls = 0;
    const store = await createStore({
      stateDirectory: directory,
      now: () => (++nowCalls, "2026-09-01T10:00:00Z" as Timestamp),
      generateExecutionInstanceId: () => "instance-one" as ExecutionInstanceId,
      rename: async (from, to) => { renameCalls++; await (await import("node:fs/promises")).rename(from, to); },
    });
    const created = unwrap(await store.create(seed()));
    const stale = await store.compareAndSwap(created.workflowId, created.executionInstanceId, 1 as never, mutation(created, "stale", 2));
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.failure.details?.[0]?.code).toBe("state_version_conflict");
    const invalid = await store.compareAndSwap(created.workflowId, created.executionInstanceId, 0 as never, mutation(created, "invalid", 3));
    expect(invalid.ok).toBe(false);
    expect(nowCalls).toBe(1);
    expect(renameCalls).toBe(1);
  });

  it("rejects path escapes, identity mismatches, symlinks, and non-files", async () => {
    const directory = await temporaryDirectory();
    const store = await createStore({ stateDirectory: directory, now: () => "2026-09-01T10:00:00Z" as Timestamp, generateExecutionInstanceId: () => "instance-one" as ExecutionInstanceId });
    const created = unwrap(await store.create(seed()));
    const wrongWorkflow = await store.get("other-flow" as WorkflowId, created.executionInstanceId);
    expect(wrongWorkflow.ok).toBe(false);
    if (!wrongWorkflow.ok) expect(wrongWorkflow.failure.details?.[0]?.code).toBe("instance_workflow_mismatch");
    const escaped = await store.get("review-flow" as WorkflowId, "../escape" as ExecutionInstanceId);
    expect(escaped.ok).toBe(false);
    if (!escaped.ok) expect(escaped.failure.code).toBe("invalid_request");

    const target = join(directory, "workflows", "instance-two.json");
    await symlink("instance-one.json", target);
    const link = await store.get("review-flow" as WorkflowId, "instance-two" as ExecutionInstanceId);
    expect(link.ok).toBe(false);
    if (!link.ok) expect(link.failure.details?.[0]?.code).toBe("state_file_not_a_file");

    await rm(target);
    await (await import("node:fs/promises")).mkdir(target);
    const directoryResult = await store.get("review-flow" as WorkflowId, "instance-two" as ExecutionInstanceId);
    expect(directoryResult.ok).toBe(false);
    if (!directoryResult.ok) expect(directoryResult.failure.details?.[0]?.code).toBe("state_file_not_a_file");
  });

  // Windows resolves the superscript forms to the same devices as the ASCII ones, so they are
  // rejected as instance ids rather than reaching a rename that fails for a different reason.
  it.each(["CON", "NUL", "COM1", "COM¹", "COM³", "LPT¹", "LPT³"])(
    "rejects the reserved device name %s as an instance id",
    async (reserved) => {
      const directory = await temporaryDirectory();
      const store = await createStore({
        stateDirectory: directory,
        now: () => "2026-09-01T10:00:00Z" as Timestamp,
        generateExecutionInstanceId: () => reserved as ExecutionInstanceId,
      });

      const created = await store.create(seed());
      expect(created.ok).toBe(false);
      if (!created.ok) expect(created.failure.details?.[0]?.code).toBe("invalid_execution_instance_id");

      const read = await store.get("review-flow" as WorkflowId, reserved as ExecutionInstanceId);
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.failure.details?.[0]?.code).toBe("invalid_execution_instance_id");
    },
  );

  it("addresses an instance id the default generator would not have produced", async () => {
    const directory = await temporaryDirectory();
    const store = await createStore({
      stateDirectory: directory,
      now: () => "2026-09-01T10:00:00Z" as Timestamp,
      generateExecutionInstanceId: () => "build-1" as ExecutionInstanceId,
    });
    const created = unwrap(await store.create(seed()));

    expect(created.executionInstanceId).toBe("build-1");
    expect(await readdir(join(directory, "workflows"))).toEqual(["build-1.json"]);
    expect(await store.get(created.workflowId, created.executionInstanceId)).toMatchObject({ ok: true, value: created });

    const escape = await store.get("review-flow" as WorkflowId, "../escape" as ExecutionInstanceId);
    expect(escape.ok).toBe(false);
    if (!escape.ok) expect(escape.failure.details?.[0]?.code).toBe("invalid_execution_instance_id");
  });

  it("refuses a state file holding malformed UTF-8 instead of substituting it", async () => {
    const directory = await temporaryDirectory();
    const store = await createStore({
      stateDirectory: directory,
      now: () => "2026-09-01T10:00:00Z" as Timestamp,
      generateExecutionInstanceId: () => "instance-one" as ExecutionInstanceId,
    });
    const created = unwrap(await store.create(seed()));
    const target = join(directory, "workflows", "instance-one.json");

    // One byte inside an identifier becomes a lone 0x80 continuation, which no UTF-8 sequence
    // can start. JSON structure and file length are untouched, so a lenient decode substitutes
    // U+FFFD, still parses, still validates, and reports the corruption as content.
    const corrupted = await readFile(target);
    const at = corrupted.indexOf(Buffer.from("agent-1", "utf8")) + "agent-".length;
    expect(at).toBeGreaterThan("agent-".length - 1);
    corrupted[at] = 0x80;
    await writeFile(target, corrupted);

    const read = await store.get(created.workflowId, created.executionInstanceId);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.failure.details?.[0]?.code).toBe("invalid_utf8");
  });

  it("gives up instead of spinning when the generator keeps returning a taken id", async () => {
    const directory = await temporaryDirectory();
    const store = await createStore({
      stateDirectory: directory,
      now: () => "2026-09-01T10:00:00Z" as Timestamp,
      generateExecutionInstanceId: () => "instance-fixed" as ExecutionInstanceId,
    });
    const first = unwrap(await store.create(seed()));
    expect(first.executionInstanceId).toBe("instance-fixed");

    const second = await store.create(seed());
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.failure.code).toBe("conflict");
      expect(second.failure.details?.[0]?.code).toBe("execution_instance_id_exhausted");
    }

    // The write chain is per directory, so a stuck create would strand every later operation.
    const third = await store.get(first.workflowId, first.executionInstanceId);
    expect(third.ok).toBe(true);
  }, 5000);

  it("addresses an instance id holding an interior space and rejects a trailing one", async () => {
    const directory = await temporaryDirectory();
    const store = await createStore({
      stateDirectory: directory,
      now: () => "2026-09-01T10:00:00Z" as Timestamp,
      generateExecutionInstanceId: () => "instance-build 1" as ExecutionInstanceId,
    });
    const created = unwrap(await store.create(seed()));
    expect(created.executionInstanceId).toBe("instance-build 1");
    expect(await readdir(join(directory, "workflows"))).toEqual(["instance-build 1.json"]);
    expect(await store.get(created.workflowId, created.executionInstanceId)).toMatchObject({ ok: true, value: created });

    const trailing = await store.get("review-flow" as WorkflowId, "instance-one " as ExecutionInstanceId);
    expect(trailing.ok).toBe(false);
    if (!trailing.ok) expect(trailing.failure.details?.[0]?.code).toBe("invalid_execution_instance_id");
  });

  it("cleans the temporary file when atomic rename fails", async () => {
    const directory = await temporaryDirectory();
    const store = await createStore({
      stateDirectory: directory,
      now: () => "2026-09-01T10:00:00Z" as Timestamp,
      generateExecutionInstanceId: () => "instance-one" as ExecutionInstanceId,
      rename: async () => { throw new Error("rename failed"); },
    });
    const result = await store.create(seed());
    expect(result.ok).toBe(false);
    expect(await readdir(join(directory, "workflows"))).toEqual([]);
  });
});
