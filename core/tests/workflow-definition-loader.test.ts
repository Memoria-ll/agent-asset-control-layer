import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildMetadataCatalog,
  parseAssetDocument,
  projectRoleDefinition,
  serializeCanonicalAsset,
  validateAsset,
  type AssetResult,
  type CatalogRevision,
  type CanonicalAsset,
  type MetadataCatalog,
} from "@aacl/core-domain";
import type { WorkflowId } from "@aacl/shared";
import {
  createFilesystemAssetStore,
  loadWorkflowEntryReference,
  loadWorkflowDefinition,
  type AssetStore,
  type ManagedAssetRoot,
  type WorkflowDefinitionLoadResult,
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

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "aacl-workflow-loader-"));
  temporaryDirectories.push(directory);
  return directory;
};

const catalog = (): MetadataCatalog => unwrap(buildMetadataCatalog({
  revision: "sha256:workflow-loader" as CatalogRevision,
  roles: [unwrap(projectRoleDefinition(assetFromDocument("---\nid: reviewer\ntype: role\nschema-version: 3\noperation: add\ntier: core\nmetadata.display-name: Reviewer\n---\n")))],
  taskTypes: [],
  providers: [],
  runtimes: [],
  models: [],
  roleModelRelations: [],
}));

const assetFromDocument = (source: string): CanonicalAsset => {
  const parsed = unwrap(parseAssetDocument(source));
  return unwrap(validateAsset(parsed));
};

const workflowDocument = (id: string, body: string): string => [
  "---",
  "schema-version: 3",
  "operation: add",
  `id: ${id}`,
  "type: workflow",
  "tier: core",
  "---",
  "```aacl-workflow",
  body,
  "```",
].join("\n");

const validBody = (workflowId?: string): string => JSON.stringify({
  ...(workflowId === undefined ? {} : { workflowId }),
  entryRoleId: "reviewer",
  entryStageId: "start",
  terminalStageId: "done",
  stages: [
    { stageId: "start", displayName: "Start", description: "Begin", requiredRoleId: "reviewer" },
    { stageId: "done", displayName: "Done", description: "Finish" },
  ],
  transitions: [{ fromStageId: "start", toStageId: "done", transitionKind: "advance" }],
});

const writeAsset = async (directory: string, relativePath: string, document: string): Promise<void> => {
  const target = join(directory, ...relativePath.split("/"));
  await mkdir(dirname(target), { recursive: true });
  const parsed = unwrap(parseAssetDocument(document));
  const asset = unwrap(validateAsset(parsed));
  await writeFile(target, unwrap(serializeCanonicalAsset(asset)), "utf8");
};

const fixture = async (documents: readonly { path: string; document: string; raw?: boolean }[] = []): Promise<{ store: AssetStore; workflowId: WorkflowId }> => {
  const directory = await temporaryDirectory();
  for (const item of documents) {
    if (item.raw === true) {
      const target = join(directory, ...item.path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, item.document, "utf8");
    } else {
      await writeAsset(directory, item.path, item.document);
    }
  }
  const roots: readonly ManagedAssetRoot[] = [{ rootId: "global", kind: "global", directory }];
  return {
    store: unwrap(createFilesystemAssetStore(roots)),
    workflowId: "review-flow" as WorkflowId,
  };
};

const load = async (store: AssetStore, workflowId: WorkflowId = "review-flow" as WorkflowId): Promise<WorkflowDefinitionLoadResult> =>
  loadWorkflowDefinition(store, workflowId, catalog());

describe("filesystem workflow definition loader", () => {
  it("loads a real workflow asset and resolves an omitted workflowId", async () => {
    const fixtureValue = await fixture([{ path: "workflows/review-flow.md", document: workflowDocument("review-flow", validBody()) }]);

    const result = await load(fixtureValue.store);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.definition.workflowId).toBe("review-flow");
      expect(result.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(result.source.relativePath).toBe("workflows/review-flow.md");
      expect(result.assetDiagnostics).toHaveLength(0);
    }
  });

  it("derives a Runtime-neutral entry reference from the loaded Workflow revision", async () => {
    const fixtureValue = await fixture([{ path: "workflows/review-flow.md", document: workflowDocument("review-flow", validBody()) }]);

    const result = await loadWorkflowEntryReference(fixtureValue.store, fixtureValue.workflowId, catalog());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry).toEqual({
        kind: "workflow-reference",
        workflowId: "review-flow",
        workflowRevision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      });
      expect(Object.keys(result.entry).sort()).toEqual(["kind", "workflowId", "workflowRevision"]);
      expect(result.source.relativePath).toBe("workflows/review-flow.md");
    }
  });

  it("keeps neighboring Asset diagnostics when deriving a Workflow entry reference", async () => {
    const fixtureValue = await fixture([
      { path: "workflows/review-flow.md", document: workflowDocument("review-flow", validBody()) },
      { path: "broken.md", document: "---\nid: broken\ntype: workflow\ntier: wrong\n---\n", raw: true },
    ]);

    const result = await loadWorkflowEntryReference(fixtureValue.store, fixtureValue.workflowId, catalog());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.assetDiagnostics).toHaveLength(1);
      expect(result.assetDiagnostics[0]?.failure.details?.[0]?.path).toEqual([
        "root", "global", "file", "broken.md", "frontmatter", "tier",
      ]);
    }
  });

  it("passes a Workflow load failure through the entry boundary", async () => {
    const fixtureValue = await fixture();

    const result = await loadWorkflowEntryReference(fixtureValue.store, fixtureValue.workflowId, catalog());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("not_found");
      expect(result.matches).toEqual([]);
    }
  });

  it("keeps filesystem diagnostics and rejects an asset identity mismatch", async () => {
    const fixtureValue = await fixture([
      { path: "workflows/review-flow.md", document: workflowDocument("review-flow", validBody("other-flow")) },
      { path: "broken.md", document: "---\nid: broken\ntype: workflow\nschema-version: 3\noperation: add\ntier: wrong\n---\n", raw: true },
    ]);

    const result = await load(fixtureValue.store);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.details?.[0]?.code).toBe("workflow_id_mismatch");
      expect(result.assetDiagnostics).toHaveLength(1);
      expect(result.assetDiagnostics[0]?.failure.details?.[0]?.path).toEqual([
        "root", "global", "file", "broken.md", "frontmatter", "tier",
      ]);
    }
  });

  it("classifies wrong type, duplicate workflow matches, and missing matches", async () => {
    const wrongType = await fixture([{ path: "rule.md", document: "---\nid: review-flow\ntype: rule\nschema-version: 3\noperation: add\ntier: core\n---\n" }]);
    const wrongTypeResult = await load(wrongType.store);
    expect(wrongTypeResult.ok).toBe(false);
    if (!wrongTypeResult.ok) {
      expect(wrongTypeResult.failure.details?.[0]?.code).toBe("wrong_asset_type");
      expect(wrongTypeResult.failure.details?.[0]?.path).toEqual([
        "root", "global", "file", "rule.md", "asset", "type",
      ]);
    }

    const duplicate = await fixture([
      { path: "one.md", document: workflowDocument("review-flow", validBody()) },
      { path: "two.md", document: workflowDocument("review-flow", validBody()) },
    ]);
    const duplicateResult = await load(duplicate.store);
    expect(duplicateResult.ok).toBe(false);
    if (!duplicateResult.ok) {
      expect(duplicateResult.failure.code).toBe("conflict");
      expect(duplicateResult.matches).toHaveLength(2);
    }

    const missing = await fixture();
    const missingResult = await load(missing.store);
    expect(missingResult.ok).toBe(false);
    if (!missingResult.ok) expect(missingResult.failure.code).toBe("not_found");
  });
});
