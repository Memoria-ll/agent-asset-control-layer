import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ASSET_TYPES, type RoleId, type TaskTypeId } from "@aacl/shared";
import {
  parseAssetDocument,
  serializeCanonicalAsset,
  validateAsset,
  type AssetResult,
  type CanonicalAsset,
} from "@aacl/core-domain";
import {
  loadMetadataCatalog,
  type ManagedAssetRoot,
  type MetadataCatalogLoadResult,
} from "../src/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});


const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "aacl-filesystem-catalog-"));
  temporaryDirectories.push(directory);
  return directory;
};

const unwrap = <Value>(result: AssetResult<Value>): Value => {
  if (!result.ok) throw new Error(result.failure.message);
  return result.value;
};

const assetFromDocument = (source: string): { readonly asset: CanonicalAsset; readonly document: string } => {
  const parsed = unwrap(parseAssetDocument(source));
  const asset = unwrap(validateAsset(parsed));
  return { asset, document: unwrap(serializeCanonicalAsset(asset)) };
};

const writeAsset = async (directory: string, relativePath: string, source: string): Promise<CanonicalAsset> => {
  const canonical = assetFromDocument(source);
  const target = join(directory, ...relativePath.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, canonical.document, "utf8");
  return canonical.asset;
};

const writeRaw = async (directory: string, relativePath: string, value: string | Buffer): Promise<void> => {
  const target = join(directory, ...relativePath.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, value);
};

const minimalDocument = (id: string, type = "rule", body = "body"): string =>
  "---\nid: " + id + "\ntype: " + type + "\nschema-version: 2\ntier: core\n---\n" + body;

const namedDocument = (id: string, type: string, displayName: string, body: string): string =>
  [
    "---",
    "schema-version: 2",
    "id: " + id,
    "type: " + type,
    "tier: core",
    "metadata.display-name: " + displayName,
    "---",
    body,
  ].join("\n");

const catalogValue = {
  schemaVersion: 1,
  providers: [
    { providerId: "anthropic", displayName: "Anthropic" },
    { providerId: "openai", displayName: "OpenAI" },
    { providerId: "local", displayName: "ローカル実行" },
  ],
  runtimes: [
    { runtimeId: "claude-code", displayName: "Claude Code", providerId: "anthropic" },
    { runtimeId: "claude-desktop", displayName: "Claude Desktop", providerId: "anthropic" },
    { runtimeId: "codex-cli", displayName: "Codex CLI", providerId: "openai" },
    { runtimeId: "codex-web", displayName: "Codex Web", providerId: "openai" },
    { runtimeId: "ollama", displayName: "Ollama", providerId: "local" },
  ],
  models: [
    { modelId: "claude-opus-5", displayName: "Claude Opus 5", providerId: "anthropic" },
    { modelId: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5", providerId: "anthropic" },
    { modelId: "gpt-5-codex", displayName: "GPT-5 Codex", providerId: "openai" },
    { modelId: "qwen3-coder", displayName: "Qwen3 Coder", providerId: "local" },
  ],
  roleModelRelations: [
    { roleId: "reviewer", modelId: "claude-opus-5" },
    { roleId: "reviewer", modelId: "gpt-5-codex" },
    { roleId: "implementer", modelId: "claude-sonnet-4-5" },
  ],
};
const catalogDocument = JSON.stringify(catalogValue, null, 2);

type Fixture = {
  readonly directory: string;
  readonly assetsRoot: string;
  readonly catalogFilePath: string;
  readonly roots: readonly ManagedAssetRoot[];
};

const createFixture = async (): Promise<Fixture> => {
  const directory = await temporaryDirectory();
  const assetsRoot = join(directory, "assets");
  await writeAsset(assetsRoot, "roles/reviewer.md", namedDocument("reviewer", "role", "Reviewer", "reviewer body"));
  await writeAsset(assetsRoot, "roles/implementer.md", namedDocument("implementer", "role", "Implementer", "implementer body"));
  await writeAsset(assetsRoot, "task-types/code-review.md", namedDocument("code-review", "task-type", "コードレビュー", "code review body"));
  await writeAsset(assetsRoot, "skills/some-skill.md", minimalDocument("some-skill", "skill", "skill body"));
  const catalogFilePath = join(directory, "execution-targets.json");
  await writeRaw(directory, "execution-targets.json", catalogDocument);
  return {
    directory,
    assetsRoot,
    catalogFilePath,
    roots: [{ rootId: "global", kind: "global", directory: assetsRoot }],
  };
};

const sourceFor = (
  fixture: Fixture,
  overrides: { readonly roots?: readonly ManagedAssetRoot[]; readonly catalogFilePath?: string } = {},
) => ({
  roots: overrides.roots ?? fixture.roots,
  catalogFilePath: overrides.catalogFilePath ?? fixture.catalogFilePath,
});

const expectFailure = (
  result: MetadataCatalogLoadResult,
  code: string,
  detailCode: string,
): void => {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.failure.code).toBe(code);
    expect(result.failure.details?.[0]?.code).toBe(detailCode);
  }
};

describe("filesystem metadata catalog", () => {
  it("rejects agent-execution as an asset type and keeps it out of the role catalog", async () => {
    const fixture = await createFixture();
    expect(ASSET_TYPES).not.toContain("agent-execution");
    await writeRaw(fixture.assetsRoot, "agent-execution.md", minimalDocument("execution-1", "agent-execution"));

    const result = await loadMetadataCatalog(sourceFor(fixture));

    expect(result.ok).toBe(true);
    expect(result.assetDiagnostics).toHaveLength(1);
    expect(result.assetDiagnostics[0]?.failure.details?.[0]?.code).toBe("invalid_value");
    expect(result.assetDiagnostics[0]?.failure.details?.[0]?.message).toContain("Unknown asset type");
    if (result.ok) expect(result.catalog.roles.size).toBe(2);
  });

  it("loads role display names and the declared catalog cardinalities", async () => {
    const fixture = await createFixture();

    const result = await loadMetadataCatalog(sourceFor(fixture));

    expect(result.ok).toBe(true);
    expect(result.assetDiagnostics).toHaveLength(0);
    if (result.ok) {
      expect(result.catalog.providers.size).toBe(3);
      expect(result.catalog.runtimes.size).toBe(5);
      expect(result.catalog.models.size).toBe(4);
      expect(result.catalog.roles.size).toBe(2);
      expect(result.catalog.taskTypes.size).toBe(1);
      expect(result.catalog.roleModelRelations).toHaveLength(3);
      // The catalogue is keyed by the branded ids, so a lookup literal carries the brand.
      expect(result.catalog.roles.get("reviewer" as RoleId)?.displayName).toBe("Reviewer");
      expect(result.catalog.taskTypes.get("code-review" as TaskTypeId)?.displayName).toBe("コードレビュー");
    }
  });

  it("reports a missing display name for a role asset", async () => {
    const fixture = await createFixture();
    await writeAsset(fixture.assetsRoot, "roles/reviewer.md", minimalDocument("reviewer", "role", "reviewer body"));

    const result = await loadMetadataCatalog(sourceFor(fixture));

    expectFailure(result, "invalid_request", "missing_display_name");
    if (!result.ok) {
      expect(result.failure.details).toHaveLength(1);
      expect(result.failure.details?.[0]?.path).toContain("roles/reviewer.md");
    }
  });

  it("limits display-name requiredness to role and task-type assets", async () => {
    const fixture = await createFixture();
    const valid = await loadMetadataCatalog(sourceFor(fixture));
    expect(valid.ok).toBe(true);
    expect(valid.assetDiagnostics).toHaveLength(0);

    await writeAsset(fixture.assetsRoot, "skills/some-skill.md", minimalDocument("some-skill", "role"));
    const invalid = await loadMetadataCatalog(sourceFor(fixture));

    expectFailure(invalid, "invalid_request", "missing_display_name");
  });

  it("rejects an array display name", async () => {
    const fixture = await createFixture();
    await writeAsset(
      fixture.assetsRoot,
      "roles/reviewer.md",
      [
        "---",
        "schema-version: 2",
        "id: reviewer",
        "type: role",
        "tier: core",
        "metadata.display-name: [a, b]",
        "---",
        "reviewer body",
      ].join("\n"),
    );

    const result = await loadMetadataCatalog(sourceFor(fixture));

    expectFailure(result, "invalid_request", "invalid_value");
    if (!result.ok) expect(result.failure.details?.[0]?.path.at(-1)).toBe("metadata.display-name");
  });

  it("preserves the incompatible contract failure from the catalog parser", async () => {
    const fixture = await createFixture();
    const document = { ...catalogValue, schemaVersion: 2 };
    await writeRaw(fixture.directory, "execution-targets.json", JSON.stringify(document));

    const result = await loadMetadataCatalog(sourceFor(fixture));

    expectFailure(result, "incompatible_contract", "unsupported_schema_version");
  });

  it("rejects unknown top-level catalog keys", async () => {
    const fixture = await createFixture();
    const document = JSON.parse(catalogDocument) as Record<string, unknown>;
    document.roles = [];
    await writeRaw(fixture.directory, "execution-targets.json", JSON.stringify(document));

    const result = await loadMetadataCatalog(sourceFor(fixture));

    expectFailure(result, "invalid_request", "unknown_key");
  });

  it("aggregates every runtime and model provider reference failure", async () => {
    const fixture = await createFixture();
    const document = JSON.parse(catalogDocument) as { providers: unknown[]; [key: string]: unknown };
    document.providers = document.providers.filter((provider) =>
      (provider as { providerId: string }).providerId !== "openai");
    await writeRaw(fixture.directory, "execution-targets.json", JSON.stringify(document));

    const result = await loadMetadataCatalog(sourceFor(fixture));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.details).toHaveLength(3);
      expect(result.failure.details?.map((detail) => detail.code)).toEqual([
        "unknown_provider_id",
        "unknown_provider_id",
        "unknown_provider_id",
      ]);
    }
  });

  it("rejects a relation whose role is absent", async () => {
    const fixture = await createFixture();
    const document = JSON.parse(catalogDocument) as { roleModelRelations: Array<Record<string, string>>; [key: string]: unknown };
    const firstRelation = document.roleModelRelations[0];
    if (firstRelation === undefined) throw new Error("The fixture relation is missing.");
    firstRelation.roleId = "unknown-role";
    await writeRaw(fixture.directory, "execution-targets.json", JSON.stringify(document));

    const result = await loadMetadataCatalog(sourceFor(fixture));

    expectFailure(result, "invalid_request", "unknown_role_id");
  });

  it("rejects duplicate role/model relations", async () => {
    const fixture = await createFixture();
    const document = JSON.parse(catalogDocument) as { roleModelRelations: Array<Record<string, string>>; [key: string]: unknown };
    const firstRelation = document.roleModelRelations[0];
    if (firstRelation === undefined) throw new Error("The fixture relation is missing.");
    document.roleModelRelations.push({ ...firstRelation });
    await writeRaw(fixture.directory, "execution-targets.json", JSON.stringify(document));

    const result = await loadMetadataCatalog(sourceFor(fixture));

    expectFailure(result, "invalid_request", "duplicate_role_model_relation");
  });

  it("rejects the same role id declared by two managed roots", async () => {
    const fixture = await createFixture();
    const secondRoot = join(fixture.directory, "second-assets");
    await writeAsset(secondRoot, "roles/reviewer-copy.md", namedDocument("reviewer", "role", "Reviewer Copy", "copy body"));

    const result = await loadMetadataCatalog(sourceFor(fixture, {
      roots: [...fixture.roots, { rootId: "personal", kind: "personal", directory: secondRoot }],
    }));

    expectFailure(result, "invalid_request", "duplicate_role_id");
    if (!result.ok) {
      expect(result.failure.details?.[0]?.message).toContain('root "global"');
      expect(result.failure.details?.[0]?.message).toContain('root "personal"');
    }
  });

  it("reports a missing catalog file instead of an empty catalog", async () => {
    const fixture = await createFixture();
    await rm(fixture.catalogFilePath);

    const result = await loadMetadataCatalog(sourceFor(fixture));

    expectFailure(result, "invalid_request", "catalog_file_missing");
  });

  it("rejects invalid UTF-8 in the catalog file", async () => {
    const fixture = await createFixture();
    await writeRaw(fixture.directory, "execution-targets.json", Buffer.from([0x7b, 0xff, 0x7d]));

    const result = await loadMetadataCatalog(sourceFor(fixture));

    expectFailure(result, "invalid_request", "invalid_utf8");
  });

  it("rejects malformed catalog JSON", async () => {
    const fixture = await createFixture();
    await writeRaw(fixture.directory, "execution-targets.json", "{");

    const result = await loadMetadataCatalog(sourceFor(fixture));

    expectFailure(result, "invalid_request", "invalid_json");
  });

  it("transfers asset diagnostics while keeping a valid catalog successful", async () => {
    const fixture = await createFixture();
    await writeRaw(fixture.assetsRoot, "roles/broken.md", "---\nid: broken\n---\nbody");

    const result = await loadMetadataCatalog(sourceFor(fixture));

    expect(result.ok).toBe(true);
    expect(result.assetDiagnostics).toHaveLength(1);
    if (result.ok) expect(result.catalog.roles.size).toBe(2);
  });

  it("rejects overlapping managed roots through the catalog loader", async () => {
    const fixture = await createFixture();
    const nestedRoot = join(fixture.assetsRoot, "roles");
    await mkdir(nestedRoot, { recursive: true });

    const result = await loadMetadataCatalog(sourceFor(fixture, {
      roots: [
        ...fixture.roots,
        { rootId: "nested", kind: "personal", directory: nestedRoot },
      ],
    }));

    expectFailure(result, "invalid_request", "invalid_root");
    expect(result.assetDiagnostics).toHaveLength(0);
  });

  it("rejects a relative catalog path before reading from the filesystem", async () => {
    const fixture = await createFixture();

    const relative = await loadMetadataCatalog(sourceFor(fixture, { catalogFilePath: "execution-targets.json" }));
    expectFailure(relative, "invalid_request", "relative_catalog_path");

    const currentDirectory = process.cwd();
    try {
      process.chdir(fixture.directory);
      const absolute = await loadMetadataCatalog(sourceFor(fixture));
      expect(absolute.ok).toBe(true);
    } finally {
      process.chdir(currentDirectory);
    }
  });

  it("classifies a catalog directory as an invalid request", async () => {
    const fixture = await createFixture();

    const result = await loadMetadataCatalog(sourceFor(fixture, { catalogFilePath: fixture.assetsRoot }));

    expectFailure(result, "invalid_request", "catalog_file_not_a_file");
    if (!result.ok) expect(result.failure.code).not.toBe("unavailable");
  });

  it("derives a deterministic catalog revision", async () => {
    const fixture = await createFixture();
    const first = await loadMetadataCatalog(sourceFor(fixture));
    const second = await loadMetadataCatalog(sourceFor(fixture));

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.catalog.revision).toBe(second.catalog.revision);
      expect(first.catalog.revision).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it("changes revision only for contributing assets and semantic catalog data", async () => {
    const fixture = await createFixture();
    const initial = await loadMetadataCatalog(sourceFor(fixture));
    expect(initial.ok).toBe(true);
    if (!initial.ok) throw new Error(initial.failure.message);

    await writeAsset(fixture.assetsRoot, "roles/reviewer.md", namedDocument("reviewer", "role", "Reviewer 2", "reviewer body"));
    const changedRole = await loadMetadataCatalog(sourceFor(fixture));
    expect(changedRole.ok).toBe(true);
    if (!changedRole.ok) throw new Error(changedRole.failure.message);
    expect(changedRole.catalog.revision).not.toBe(initial.catalog.revision);

    await writeAsset(fixture.assetsRoot, "skills/some-skill.md", minimalDocument("some-skill", "skill", "changed skill body"));
    const changedSkill = await loadMetadataCatalog(sourceFor(fixture));
    expect(changedSkill.ok).toBe(true);
    if (!changedSkill.ok) throw new Error(changedSkill.failure.message);
    expect(changedSkill.catalog.revision).toBe(changedRole.catalog.revision);

    const document = JSON.parse(catalogDocument) as Record<string, unknown>;
    const reordered = {
      schemaVersion: document.schemaVersion,
      models: document.models,
      providers: document.providers,
      runtimes: document.runtimes,
      roleModelRelations: document.roleModelRelations,
    };
    await writeRaw(fixture.directory, "execution-targets.json", JSON.stringify(reordered, null, 4));
    const reformatted = await loadMetadataCatalog(sourceFor(fixture));
    expect(reformatted.ok).toBe(true);
    if (!reformatted.ok) throw new Error(reformatted.failure.message);
    expect(reformatted.catalog.revision).toBe(changedSkill.catalog.revision);
  });
});
