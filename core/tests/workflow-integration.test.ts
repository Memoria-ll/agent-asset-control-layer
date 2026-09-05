import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildMetadataCatalog,
  applyWorkflowTransition,
  initializeWorkflowState,
  parseAssetDocument,
  possibleWorkflowTransitions,
  projectRoleDefinition,
  serializeCanonicalAsset,
  validateAsset,
  type AssetResult,
  type CatalogRevision,
  type MetadataCatalog,
} from "@aacl/core-domain";
import type { AgentExecutionId, ExecutionInstanceId, RoleId, SnapshotId, Timestamp, WorkflowId } from "@aacl/shared";
import { parseWorkflowStateDto } from "@aacl/shared";
import {
  createFilesystemAssetStore,
  createWorkflowStateStore,
  loadWorkflowDefinition,
} from "../src/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

const unwrap = <Value>(result: AssetResult<Value>): Value => {
  if (!result.ok) throw new Error(result.failure.message);
  return result.value;
};

const catalog = (): MetadataCatalog => unwrap(buildMetadataCatalog({
  revision: "sha256:workflow-integration" as CatalogRevision,
  roles: [unwrap(projectRoleDefinition(assetFromDocument("---\nid: reviewer\ntype: role\nschema-version: 3\noperation: add\ntier: core\nmetadata.display-name: Reviewer\n---\n")))],
  taskTypes: [], providers: [], runtimes: [], models: [], roleModelRelations: [],
}));

const assetFromDocument = (source: string) => unwrap(validateAsset(unwrap(parseAssetDocument(source))));

const workflowDocument = "---\nid: review-flow\ntype: workflow\nschema-version: 3\noperation: add\ntier: core\n---\n```aacl-workflow\n" + JSON.stringify({
  entryRoleId: "reviewer",
  entryStageId: "start",
  terminalStageId: "done",
  stages: [
    { stageId: "start", displayName: "Start", description: "Begin", requiredRoleId: "reviewer" },
    { stageId: "done", displayName: "Done", description: "Finish" },
  ],
  transitions: [{ fromStageId: "start", toStageId: "done", transitionKind: "advance" }],
}) + "\n```";

describe("workflow loader and state integration", () => {
  it("queries, explicitly applies, CAS-updates, and reads the same real state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aacl-workflow-integration-"));
    temporaryDirectories.push(directory);
    const assetPath = join(directory, "assets", "review-flow.md");
    await mkdir(dirname(assetPath), { recursive: true });
    const asset = assetFromDocument(workflowDocument);
    await writeFile(assetPath, unwrap(serializeCanonicalAsset(asset)), "utf8");

    const assets = unwrap(createFilesystemAssetStore([{ rootId: "global", kind: "global", directory: join(directory, "assets") }]));
    const loaded = await loadWorkflowDefinition(assets, "review-flow" as WorkflowId, catalog());
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const stateStore = unwrap(await createWorkflowStateStore({
      stateDirectory: join(directory, "state"),
      now: () => "2026-09-01T10:00:00Z" as Timestamp,
      newInstanceSuffix: () => "one",
    }));
    const seed = unwrap(initializeWorkflowState(loaded.definition, {
      workflowRevision: loaded.revision,
      linkedAgentExecutionIds: ["agent-1" as AgentExecutionId],
      linkedSnapshotIds: ["snapshot-1" as SnapshotId],
    }, { roleId: "reviewer" as RoleId, availableCapabilityRefs: [], availableArtifactRefs: [] }));
    const created = unwrap(await stateStore.create(seed));
    const path = join(directory, "state", "workflows", "instance-one.json");
    const beforeBytes = await readFile(path, "utf8");
    const candidates = possibleWorkflowTransitions(loaded.definition, created, {
      roleId: "reviewer" as RoleId,
      availableCapabilityRefs: [],
      availableArtifactRefs: [],
    });
    expect(candidates.ok).toBe(true);
    if (!candidates.ok) return;
    expect(candidates.value).toHaveLength(1);
    const selected = candidates.value[0];
    if (selected === undefined) return;
    const afterQueryBytes = await readFile(path, "utf8");
    expect(afterQueryBytes).toBe(beforeBytes);
    expect(created.stateVersion).toBe(0);

    const applied = unwrap(applyWorkflowTransition(
      loaded.definition,
      created,
      { toStageId: selected.toStageId, transitionKind: selected.transitionKind, expectedStateVersion: selected.stateVersion },
      { roleId: "reviewer" as RoleId, availableCapabilityRefs: [], availableArtifactRefs: [] },
    ));
    const updated = unwrap(await stateStore.compareAndSwap(created.workflowId, loaded.revision, created.executionInstanceId, 0 as never, applied));
    expect(updated.stateVersion).toBe(1);
    expect(updated.currentStageId).toBe("done");
    expect(updated.linkedAgentExecutionIds).toEqual(["agent-1"]);
    const fetched = unwrap(await stateStore.get(created.workflowId, loaded.revision, created.executionInstanceId));
    expect(fetched).toEqual(updated);

    const beforeStaleBytes = await readFile(path, "utf8");
    const stale = await stateStore.compareAndSwap(created.workflowId, loaded.revision, created.executionInstanceId, 0 as never, applied);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.failure.code).toBe("conflict");
    const afterStaleBytes = await readFile(path, "utf8");
    expect(afterStaleBytes).toBe(beforeStaleBytes);
    expect(parseWorkflowStateDto(JSON.parse(afterStaleBytes)).stateVersion).toBe(1);
  });
});
