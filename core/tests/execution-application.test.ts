import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMetadataCatalog, parseAssetDocument, projectRoleDefinition, serializeCanonicalAsset, validateAsset, type AssetResult, type CatalogRevision, type MetadataCatalog } from "@aacl/core-domain";
import type { WorkflowStartRequestInput } from "@aacl/shared";
import { startWorkflowExecution, createFilesystemAssetStore, createWorkflowStateStore, type WorkflowStartCommitPort } from "../src/index.ts";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));
const unwrap = <T>(value: AssetResult<T>): T => { if (!value.ok) throw new Error(value.failure.message); return value.value; };
const asset = (source: string) => unwrap(validateAsset(unwrap(parseAssetDocument(source))));
const catalog = (): MetadataCatalog => unwrap(buildMetadataCatalog({ revision: "sha256:catalog" as CatalogRevision, roles: [unwrap(projectRoleDefinition(asset("---\nid: reviewer\ntype: role\nschema-version: 3\noperation: add\ntier: core\nmetadata.display-name: Reviewer\n---\n")))], taskTypes: [], providers: [], runtimes: [], models: [], roleModelRelations: [] }));
const workflow = `---\nid: review-flow\ntype: workflow\nschema-version: 3\noperation: add\ntier: core\n---\n\`\`\`aacl-workflow\n${JSON.stringify({ entryRoleId: "reviewer", entryStageId: "start", terminalStageId: "start", stages: [{ stageId: "start", displayName: "Start", description: "Begin", requiredRoleId: "reviewer" }], transitions: [] })}\n\`\`\``;

const request = (
  revision: string,
  context: WorkflowStartRequestInput["context"] = { executionMode: "advisory_preparation", workflow: { kind: "none" }, roleId: "reviewer" },
  startFrom: WorkflowStartRequestInput["startFrom"] = { kind: "advisory_none" },
  sessionId?: string,
): WorkflowStartRequestInput => ({
  operation: "workflow_start",
  idempotencyKey: "start-1",
  context,
  startFrom,
  target: { workflowId: "review-flow", workflowRevision: revision },
  ...(sessionId === undefined ? {} : { sessionId }),
  availableCapabilityRefs: [],
  availableArtifactRefs: [],
});

describe("workflow start application boundary", () => {
  it("loads the exact revision and submits one linked bundle without pre-commit state writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "aacl-execution-")); directories.push(root);
    const assetPath = join(root, "assets", "review-flow.md"); await mkdir(dirname(assetPath), { recursive: true });
    const stored = asset(workflow); await writeFile(assetPath, unwrap(serializeCanonicalAsset(stored)), "utf8");
    const assets = unwrap(createFilesystemAssetStore([{ rootId: "global", kind: "global", directory: join(root, "assets") }]));
    let instanceNumber = 0;
    const stateStore = unwrap(await createWorkflowStateStore({ stateDirectory: join(root, "state"), newInstanceSuffix: () => ["one", "two", "three"][instanceNumber++] ?? "later", now: () => "2026-09-01T10:00:00Z" as never }));
    let submitted = 0;
    const port: WorkflowStartCommitPort = { commit: async (value) => {
      submitted += 1;
      const state = value.workflowState;
      const created = await stateStore.create({
        workflowId: state.workflowId,
        workflowRevision: state.workflowRevision,
        currentStageId: state.currentStageId,
        entryRoleId: state.entryRoleId,
        currentRoleId: state.currentRoleId,
        linkedAgentExecutionIds: state.linkedAgentExecutionIds,
        linkedSnapshotIds: state.linkedSnapshotIds,
      }, state.executionInstanceId);
      return created.ok ? { ok: true, value } : { ok: false, failure: created.failure };
    } };
    const lookup = await assets.get("review-flow" as never);
    const revision = lookup.matches[0]?.revision;
    if (revision === undefined) throw new Error("fixture revision missing");
    const result = await startWorkflowExecution(request(revision), { assetStore: assets, catalog: catalog(), stateStore, commitPort: port, now: () => "2026-09-01T10:00:00Z", newAgentExecutionId: () => "agent-1" as never });
    expect(result).toMatchObject({ ok: true }); expect(submitted).toBe(1);
    if (!result.ok) return;
    expect(result.value.workflowState.workflowRevision).toBe(revision);
    await expect(stateStore.get("review-flow" as never, revision, "instance-one" as never)).resolves.toMatchObject({ ok: true, value: result.value.workflowState });
    expect(result.value.agentExecution.workflowBinding).toMatchObject({ kind: "workflow", workflowId: "review-flow", workflowRevision: revision, executionInstanceId: "instance-one" });
    expect(result.value.nextContext.workflow).toMatchObject({ kind: "selected", workflowRevision: revision, stageId: "start" });
    expect("sessionUpdate" in result.value).toBe(false);
    const withSession = await startWorkflowExecution(request(revision, undefined, undefined, "session-1"), { assetStore: assets, catalog: catalog(), stateStore, commitPort: port, now: () => "2026-09-01T10:00:00Z", newAgentExecutionId: () => "agent-2" as never });
    expect(withSession.ok).toBe(true);
    if (withSession.ok) expect(withSession.value.sessionUpdate).toEqual({ sessionId: "session-1", addAgentExecutionId: "agent-2" });
    const boundedSkill = await startWorkflowExecution(request(
      revision,
      { executionMode: "advisory_preparation", workflow: { kind: "standalone", skillId: "skill-a" }, roleId: "reviewer" },
      { kind: "bounded_skill_completed", skillId: "skill-a" },
    ), { assetStore: assets, catalog: catalog(), stateStore, commitPort: port, now: () => "2026-09-01T10:00:00Z", newAgentExecutionId: () => "agent-3" as never });
    expect(boundedSkill.ok).toBe(true);
  });

  it("does not write state when the composite commit fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "aacl-execution-fail-")); directories.push(root);
    const assetPath = join(root, "assets", "review-flow.md"); await mkdir(dirname(assetPath), { recursive: true });
    const stored = asset(workflow); await writeFile(assetPath, unwrap(serializeCanonicalAsset(stored)), "utf8");
    const assets = unwrap(createFilesystemAssetStore([{ rootId: "global", kind: "global", directory: join(root, "assets") }]));
    const stateStore = unwrap(await createWorkflowStateStore({ stateDirectory: join(root, "state"), newInstanceSuffix: () => "one" }));
    const port: WorkflowStartCommitPort = { commit: async () => ({ ok: false, failure: { code: "unavailable", message: "commit failed" } }) };
    const lookup = await assets.get("review-flow" as never);
    const revision = lookup.matches[0]?.revision;
    if (revision === undefined) throw new Error("fixture revision missing");
    const result = await startWorkflowExecution(request(revision), { assetStore: assets, catalog: catalog(), stateStore, commitPort: port, now: () => "2026-09-01T10:00:00Z", newAgentExecutionId: () => "agent-1" as never });
    expect(result).toMatchObject({ ok: false, failure: { code: "unavailable" } });
    await expect(stateStore.get("review-flow" as never, revision, "instance-one" as never)).resolves.toMatchObject({ ok: false, failure: { code: "not_found" } });
  });

  it("rejects a stale target revision before invoking the commit port", async () => {
    const root = await mkdtemp(join(tmpdir(), "aacl-execution-stale-")); directories.push(root);
    const assetPath = join(root, "assets", "review-flow.md"); await mkdir(dirname(assetPath), { recursive: true });
    const stored = asset(workflow); await writeFile(assetPath, unwrap(serializeCanonicalAsset(stored)), "utf8");
    const assets = unwrap(createFilesystemAssetStore([{ rootId: "global", kind: "global", directory: join(root, "assets") }]));
    const stateStore = unwrap(await createWorkflowStateStore({ stateDirectory: join(root, "state"), newInstanceSuffix: () => "one" }));
    let commits = 0;
    const port: WorkflowStartCommitPort = { commit: async (value) => { commits += 1; return { ok: true, value }; } };
    const lookup = await assets.get("review-flow" as never);
    const revision = lookup.matches[0]?.revision;
    if (revision === undefined) throw new Error("fixture revision missing");
    const result = await startWorkflowExecution(request(`${revision}-stale`), { assetStore: assets, catalog: catalog(), stateStore, commitPort: port, now: () => "2026-09-01T10:00:00Z", newAgentExecutionId: () => "agent-1" as never });
    expect(result).toMatchObject({ ok: false, failure: { code: "conflict" } });
    expect(commits).toBe(0);
  });
});
