import { symlink } from "node:fs/promises";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  asAssetId,
  parseAssetDocument,
  serializeCanonicalAsset,
  validateAsset,
  type AssetResult,
  type CanonicalAsset,
} from "@aacl/core-domain";
import {
  createFilesystemAssetStore,
  type AssetStore,
  type ManagedAssetRoot,
} from "../src/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "aacl-filesystem-store-"));
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

const storeFor = (
  roots: readonly ManagedAssetRoot[],
  options?: { readonly rename?: (from: string, to: string) => Promise<void> },
): AssetStore => unwrap(createFilesystemAssetStore(roots, options));

const minimalDocument = (id: string, type = "rule", body = "body"): string =>
  "---\nid: " + id + "\ntype: " + type + "\ntier: core\n---\n" + body;

const goldenDocument = [
  "---",
  "schema-version: 1",
  "id: review-checklist",
  "type: rule",
  "tier: core",
  "lifecycle: active",
  "scope.project: [project-one, project-two]",
  "scope.workflow: [review-flow]",
  "scope.stage: [review]",
  "scope.task-type: [implementation]",
  "scope.role: [reviewer]",
  "scope.provider: [anthropic]",
  "scope.runtime: [claude-code]",
  "scope.model: [sol]",
  "scope.directory: [/workspace, /workspace/src]",
  "requires: [naming-convention, safety-rule]",
  "metadata.author: Jane Doe",
  "metadata.tags: [Doe, John]",
  "---",
  "# Review checklist",
  "",
  "- inspect",
].join("\n");

describe("filesystem asset store", () => {
  it("ignores a headerless markdown file before decoding it", async () => {
    const root = await temporaryDirectory();
    await writeAsset(root, "valid.md", minimalDocument("valid-asset"));
    await writeRaw(root, "notes.md", Buffer.from([0x6e, 0x6f, 0x74, 0x65, 0x73, 0x0a, 0xff]));
    const store = storeFor([{ rootId: "global", kind: "global", directory: root }]);

    const result = await store.list();

    expect(Object.keys(result).sort()).toEqual(["assets", "failures"]);
    expect(result.assets).toHaveLength(1);
    expect(result.failures).toHaveLength(0);
  });

  it("keeps valid assets when another headed file is malformed", async () => {
    const root = await temporaryDirectory();
    await writeAsset(root, "valid.md", minimalDocument("valid-asset"));
    await writeRaw(root, "broken.md", "---\nid: broken\n---\nbody");
    const store = storeFor([{ rootId: "global", kind: "global", directory: root }]);

    const result = await store.list();

    expect(result.assets).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.failure.code).toBe("invalid_request");
  });

  it("uses the declared id rather than the filename for lookup", async () => {
    const root = await temporaryDirectory();
    await writeAsset(root, "renamed-name.md", minimalDocument("canonical-id"));
    const store = storeFor([{ rootId: "global", kind: "global", directory: root }]);
    const assetId = unwrap(asAssetId("canonical-id"));

    const result = await store.get(assetId);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.source.relativePath).toBe("renamed-name.md");
  });

  it("returns candidates from global, personal, and project roots", async () => {
    const globalRoot = await temporaryDirectory();
    const personalRoot = await temporaryDirectory();
    const projectRoot = await temporaryDirectory();
    for (const root of [globalRoot, personalRoot, projectRoot]) {
      await writeAsset(root, "asset.md", minimalDocument("shared-id"));
    }
    const store = storeFor([
      { rootId: "global", kind: "global", directory: globalRoot },
      { rootId: "personal", kind: "personal", directory: personalRoot },
      { rootId: "project", kind: "project", projectId: "project-one", directory: projectRoot },
    ]);
    const assetId = unwrap(asAssetId("shared-id"));

    const result = await store.get(assetId);

    expect(result.matches).toHaveLength(3);
    expect(result.matches.map((match) => match.source.kind)).toEqual(["global", "personal", "project"]);
    expect(result.matches.find((match) => match.source.kind === "project")?.source).toEqual({
      rootId: "project",
      kind: "project",
      projectId: "project-one",
      relativePath: "asset.md",
    });
  });

  it("returns both same-root candidates and one duplicate conflict", async () => {
    const root = await temporaryDirectory();
    await writeAsset(root, "first.md", minimalDocument("duplicate-id"));
    await writeAsset(root, "nested/second.md", minimalDocument("duplicate-id"));
    const store = storeFor([{ rootId: "global", kind: "global", directory: root }]);

    const result = await store.list();

    expect(result.assets).toHaveLength(2);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.failure.code).toBe("conflict");
    expect(result.failures[0]?.failure.details?.[0]?.code).toBe("duplicate_asset_id");
  });

  it("normalizes BOM and CRLF input to the same revision and LF body", async () => {
    const lfRoot = await temporaryDirectory();
    const crlfRoot = await temporaryDirectory();
    const canonical = assetFromDocument(goldenDocument);
    await writeRaw(lfRoot, "asset.md", canonical.document);
    await writeRaw(crlfRoot, "asset.md", "\uFEFF" + canonical.document.replace(/\n/g, "\r\n"));
    const store = storeFor([
      { rootId: "lf", kind: "global", directory: lfRoot },
      { rootId: "crlf", kind: "personal", directory: crlfRoot },
    ]);

    const result = await store.list();

    expect(result.failures).toHaveLength(0);
    expect(result.assets).toHaveLength(2);
    expect(new Set(result.assets.map((asset) => asset.revision)).size).toBe(1);
    expect(result.assets[0]?.asset.body).toBe("# Review checklist\n\n- inspect");
    expect(result.assets[1]?.asset.body).toBe("# Review checklist\n\n- inspect");
  });

  it("pins the canonical full-field revision golden", async () => {
    const root = await temporaryDirectory();
    await writeAsset(root, "review.md", goldenDocument);
    const store = storeFor([{ rootId: "global", kind: "global", directory: root }]);

    const result = await store.list();

    expect(result.failures).toHaveLength(0);
    expect(result.assets[0]?.revision).toBe("sha256:884a4c01a9ea2fcc261b8f4de27e67eac0c8bda9a9416cfdbc66912b86e10e96");
  });

  it("changes revision when only the declared type changes", async () => {
    const root = await temporaryDirectory();
    const rule = assetFromDocument(goldenDocument);
    await writeRaw(root, "golden.md", rule.document);
    const store = storeFor([{ rootId: "global", kind: "global", directory: root }]);
    const before = await store.list();
    const skill = assetFromDocument(goldenDocument.replace("type: rule", "type: skill"));
    await writeRaw(root, "golden.md", skill.document);

    const after = await store.get(rule.asset.id);

    expect(before.assets[0]?.asset.body).toBe(after.matches[0]?.asset.body);
    expect(before.assets[0]?.revision).not.toBe(after.matches[0]?.revision);
  });

  it("preserves body terminal LF through save and reload", async () => {
    const root = await temporaryDirectory();
    const withoutTerminalLf = assetFromDocument(minimalDocument("without-terminal-lf", "rule", "body"));
    const withTerminalLf = assetFromDocument(minimalDocument("with-terminal-lf", "rule", "body\n"));
    const store = storeFor([{ rootId: "global", kind: "global", directory: root }]);

    const first = await store.save({ rootId: "global", relativePath: "without.md", asset: withoutTerminalLf.asset });
    const second = await store.save({ rootId: "global", relativePath: "with.md", asset: withTerminalLf.asset });
    const result = await store.list();

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(result.assets.find((asset) => asset.asset.id === "without-terminal-lf")?.asset.body).toBe("body");
    expect(result.assets.find((asset) => asset.asset.id === "with-terminal-lf")?.asset.body).toBe("body\n");
    expect(first.ok && second.ok ? first.value.revision : "").not.toBe(second.ok ? second.value.revision : "");
  });

  it("adds schema-version and round-trips a schema-version-less asset", async () => {
    const root = await temporaryDirectory();
    const input = "---\nid: round-trip\ntype: rule\ntier: core\nscope.project: [project-two, project-one]\nrequires: [safety-rule, naming-convention]\n---\nbody";
    const canonical = assetFromDocument(input);
    const store = storeFor([{ rootId: "global", kind: "global", directory: root }]);

    const saved = await store.save({ rootId: "global", relativePath: "round-trip.md", asset: canonical.asset });
    const storedText = await readFile(join(root, "round-trip.md"), "utf8");
    const listed = await store.get(canonical.asset.id);

    expect(saved.ok).toBe(true);
    expect(storedText).toContain("schema-version: 1\n");
    expect(storedText.split("\n")).toHaveLength(input.split("\n").length + 1);
    expect(listed.matches[0]?.asset).toEqual(canonical.asset);
    expect(listed.matches[0]?.revision).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rejects an externally edited target when expectedRevision is stale", async () => {
    const root = await temporaryDirectory();
    const original = assetFromDocument(minimalDocument("guarded", "rule", "original"));
    const changed = assetFromDocument(minimalDocument("guarded", "skill", "original"));
    await writeRaw(root, "guarded.md", original.document);
    const store = storeFor([{ rootId: "global", kind: "global", directory: root }]);
    const listed = await store.list();
    const expectedRevision = listed.assets[0]?.revision;
    if (expectedRevision === undefined) throw new Error("The initial asset was not listed.");
    await writeRaw(root, "guarded.md", changed.document);
    const before = await readFile(join(root, "guarded.md"));

    const result = await store.save({ rootId: "global", relativePath: "guarded.md", asset: original.asset, expectedRevision });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("conflict");
    expect(await readFile(join(root, "guarded.md"))).toEqual(before);
    expect(await readdir(root)).toEqual(["guarded.md"]);
  });

  it("replaces a matching target but protects a different target identity", async () => {
    const root = await temporaryDirectory();
    const first = assetFromDocument(minimalDocument("first-id", "rule", "before"));
    const replacement = assetFromDocument(minimalDocument("first-id", "rule", "after"));
    const other = assetFromDocument(minimalDocument("other-id"));
    await writeRaw(root, "target.md", first.document);
    const store = storeFor([{ rootId: "global", kind: "global", directory: root }]);

    const replaced = await store.save({ rootId: "global", relativePath: "target.md", asset: replacement.asset });
    expect(replaced.ok).toBe(true);
    await writeRaw(root, "target.md", other.document);
    const before = await readFile(join(root, "target.md"));
    const conflict = await store.save({ rootId: "global", relativePath: "target.md", asset: replacement.asset });

    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.failure.code).toBe("conflict");
    expect(await readFile(join(root, "target.md"))).toEqual(before);
  });

  it("does not move or delete the old file during save", async () => {
    const root = await temporaryDirectory();
    const asset = assetFromDocument(minimalDocument("stationary-id"));
    await writeRaw(root, "old.md", asset.document);
    const store = storeFor([{ rootId: "global", kind: "global", directory: root }]);
    const before = await readFile(join(root, "old.md"));

    const result = await store.save({ rootId: "global", relativePath: "new.md", asset: asset.asset });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("conflict");
    expect(await readFile(join(root, "old.md"))).toEqual(before);
    await expect(readFile(join(root, "new.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["../escape.md", "/absolute.md", "nested\\escape.md", "nul\0name.md", "not-markdown.txt"])(
    "rejects unsafe save path %s without writing",
    async (relativePath) => {
      const root = await temporaryDirectory();
      const asset = assetFromDocument(minimalDocument("path-safe"));
      const store = storeFor([{ rootId: "global", kind: "global", directory: root }]);

      const result = await store.save({ rootId: "global", relativePath, asset: asset.asset });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.code).toBe("invalid_request");
      expect(await readdir(root)).toHaveLength(0);
    },
  );

  it("reports invalid roots as invalid_request and rejects relative roots at the factory", async () => {
    const existingRoot = await temporaryDirectory();
    const filePath = join(existingRoot, "not-a-directory");
    await writeFile(filePath, "file", "utf8");
    const missingRoot = join(existingRoot, "missing");
    const relativeFactory = createFilesystemAssetStore([{ rootId: "relative", kind: "global", directory: "relative-root" }]);

    expect(relativeFactory.ok).toBe(false);
    const store = storeFor([
      { rootId: "missing", kind: "global", directory: missingRoot },
      { rootId: "file", kind: "personal", directory: filePath },
    ]);
    const result = await store.list();

    expect(result.assets).toHaveLength(0);
    expect(result.failures).toHaveLength(2);
    expect(result.failures.every((item) => item.failure.code === "invalid_request")).toBe(true);
    expect(result.failures.every((item) => item.failure.details?.[0]?.code === "invalid_root")).toBe(true);
  });

  it("reports strict UTF-8 failure without losing valid assets", async () => {
    const root = await temporaryDirectory();
    await writeAsset(root, "valid.md", minimalDocument("valid-utf8"));
    await writeRaw(root, "invalid.md", Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0x69, 0x64, 0x3a, 0x20, 0x62, 0x61, 0x64, 0x0a, 0xff, 0x0a, 0x2d, 0x2d, 0x2d]));
    const store = storeFor([{ rootId: "global", kind: "global", directory: root }]);

    const result = await store.list();

    expect(result.assets).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.failure.code).toBe("invalid_request");
    expect(result.failures[0]?.failure.details?.[0]?.code).toBe("invalid_utf8");
    expect(result.failures[0]?.failure.details?.[0]?.path).toEqual(["root", "global", "file", "invalid.md"]);
  });

  it("classifies a reproducible POSIX permission read failure as unavailable", async ({ skip }) => {
    if (process.platform === "win32") {
      skip("POSIX permission bits cannot reproduce this read failure on Windows.");
      return;
    }
    const readableRoot = await temporaryDirectory();
    const restrictedRoot = await temporaryDirectory();
    await writeAsset(readableRoot, "valid.md", minimalDocument("readable"));
    await writeAsset(restrictedRoot, "restricted.md", minimalDocument("restricted"));
    const restrictedPath = join(restrictedRoot, "restricted.md");
    await chmod(restrictedPath, 0o000);

    let permissionDenied = false;
    try {
      await readFile(restrictedPath);
    } catch (error) {
      permissionDenied = error !== null && typeof error === "object" && "code" in error && (error.code === "EACCES" || error.code === "EPERM");
    }
    if (!permissionDenied) {
      await chmod(restrictedPath, 0o644);
      // Skip only when the environment's effective user can read mode-000 files.
      skip("The environment cannot reproduce a POSIX permission-denied read.");
      return;
    }

    try {
      const store = storeFor([
        { rootId: "readable", kind: "global", directory: readableRoot },
        { rootId: "restricted", kind: "personal", directory: restrictedRoot },
      ]);
      const result = await store.list();

      expect(result.assets).toHaveLength(1);
      expect(result.assets[0]?.asset.id).toBe("readable");
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.failure.code).toBe("unavailable");
    } finally {
      await chmod(restrictedPath, 0o644);
    }
  });

  it("keeps scanning sibling directories after multiple nested read failures", async ({ skip }) => {
    if (process.platform === "win32") {
      skip("POSIX permission bits cannot reproduce this read failure on Windows.");
      return;
    }
    const root = await temporaryDirectory();
    const firstRestricted = join(root, "restricted-one");
    const secondRestricted = join(root, "restricted-two");
    await mkdir(firstRestricted);
    await mkdir(secondRestricted);
    await writeAsset(root, "visible.md", minimalDocument("visible"));
    await chmod(firstRestricted, 0o000);
    await chmod(secondRestricted, 0o000);

    let permissionDenied = false;
    try {
      await readdir(firstRestricted);
    } catch (error) {
      permissionDenied = error !== null && typeof error === "object" && "code" in error && (error.code === "EACCES" || error.code === "EPERM");
    }
    if (!permissionDenied) {
      await chmod(firstRestricted, 0o755);
      await chmod(secondRestricted, 0o755);
      // Skip only when the environment's effective user can read mode-000 directories.
      skip("The environment cannot reproduce a POSIX permission-denied directory read.");
      return;
    }

    try {
      const store = storeFor([{ rootId: "global", kind: "global", directory: root }]);
      const result = await store.list();

      expect(result.assets).toHaveLength(1);
      expect(result.assets[0]?.asset.id).toBe("visible");
      expect(result.failures).toHaveLength(2);
      expect(result.failures.every((item) => item.failure.code === "unavailable")).toBe(true);
      expect(result.failures.map((item) => item.failure.details?.[0]?.path.join("/")).sort()).toEqual([
        "root/global/file/restricted-one",
        "root/global/file/restricted-two",
      ]);
    } finally {
      await chmod(firstRestricted, 0o755);
      await chmod(secondRestricted, 0o755);
    }
  });

  it("saves to a healthy root despite an unavailable unrelated root", async ({ skip }) => {
    if (process.platform === "win32") {
      skip("POSIX permission bits cannot reproduce this read failure on Windows.");
      return;
    }
    const globalRoot = await temporaryDirectory();
    const personalRoot = await temporaryDirectory();
    const restrictedPath = join(personalRoot, "restricted.md");
    await writeAsset(personalRoot, "restricted.md", minimalDocument("restricted"));
    const globalAsset = assetFromDocument(minimalDocument("global-saved")).asset;
    const personalAsset = assetFromDocument(minimalDocument("personal-saved")).asset;
    await chmod(restrictedPath, 0o000);

    let permissionDenied = false;
    try {
      await readFile(restrictedPath);
    } catch (error) {
      permissionDenied = error !== null && typeof error === "object" && "code" in error && (error.code === "EACCES" || error.code === "EPERM");
    }
    if (!permissionDenied) {
      await chmod(restrictedPath, 0o644);
      // Skip only when the environment's effective user can read mode-000 files.
      skip("The environment cannot reproduce a POSIX permission-denied read.");
      return;
    }

    try {
      const store = storeFor([
        { rootId: "global", kind: "global", directory: globalRoot },
        { rootId: "personal", kind: "personal", directory: personalRoot },
      ]);

      const globalResult = await store.save({ rootId: "global", relativePath: "global.md", asset: globalAsset });
      expect(globalResult.ok).toBe(true);

      const personalResult = await store.save({ rootId: "personal", relativePath: "personal.md", asset: personalAsset });
      expect(personalResult.ok).toBe(false);
      if (!personalResult.ok) expect(personalResult.failure.code).toBe("unavailable");
    } finally {
      await chmod(restrictedPath, 0o644);
    }
  });

  it("does not follow symlink directories and diagnoses markdown symlinks", async ({ skip }) => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await writeAsset(outside, "escaped.md", minimalDocument("escaped"));
    try {
      await symlink(outside, join(root, "linked-directory"), "dir");
      await symlink(join(outside, "escaped.md"), join(root, "linked.md"));
    } catch (error) {
      if (error !== null && typeof error === "object" && "code" in error && error.code === "EPERM") {
        // Symlink privilege is an environment limitation, not a store result.
        skip("The environment does not permit filesystem symlink creation.");
        return;
      }
      throw error;
    }
    const store = storeFor([{ rootId: "global", kind: "global", directory: root }]);

    const result = await store.list();

    expect(result.assets).toHaveLength(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.source).toEqual({ rootId: "global", kind: "global", relativePath: "linked.md" });
    expect(result.failures[0]?.failure.code).toBe("invalid_request");
    expect(result.failures[0]?.failure.details?.[0]?.code).toBe("unsupported_symlink");
  });

  it("cleans up the real temporary file when injected rename fails", async () => {
    const root = await temporaryDirectory();
    const asset = assetFromDocument(minimalDocument("rename-failure"));
    const store = storeFor(
      [{ rootId: "global", kind: "global", directory: root }],
      { rename: async () => { throw new Error("injected rename failure"); } },
    );

    const result = await store.save({ rootId: "global", relativePath: "target.md", asset: asset.asset });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("unavailable");
    expect(await readdir(root)).toEqual([]);
  });

  it("serializes concurrent saves with the same expected revision", async () => {
    const root = await temporaryDirectory();
    const initial = assetFromDocument(minimalDocument("concurrent", "rule", "initial"));
    const first = assetFromDocument(minimalDocument("concurrent", "rule", "first"));
    const second = assetFromDocument(minimalDocument("concurrent", "rule", "second"));
    await writeRaw(root, "concurrent.md", initial.document);
    const store = storeFor([{ rootId: "global", kind: "global", directory: root }]);
    const listed = await store.list();
    const expectedRevision = listed.assets[0]?.revision;
    if (expectedRevision === undefined) throw new Error("The initial asset was not listed.");

    const results = await Promise.all([
      store.save({ rootId: "global", relativePath: "concurrent.md", asset: first.asset, expectedRevision }),
      store.save({ rootId: "global", relativePath: "concurrent.md", asset: second.asset, expectedRevision }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    const winnerIndex = results.findIndex((result) => result.ok);
    const loser = results.find((result) => !result.ok);
    expect(winnerIndex).toBeGreaterThanOrEqual(0);
    expect(loser?.ok).toBe(false);
    if (loser !== undefined && !loser.ok) expect(loser.failure.code).toBe("conflict");
    expect(await readFile(join(root, "concurrent.md"), "utf8")).toBe(winnerIndex === 0 ? first.document : second.document);
  });

  it("saves an asset with a filesystem-limit basename", async ({ skip }) => {
    const root = await temporaryDirectory();
    const relativePath = "a".repeat(251) + ".md";
    const probePath = join(root, relativePath);
    try {
      await writeFile(probePath, "", { flag: "wx" });
      await rm(probePath);
    } catch {
      await rm(probePath, { force: true });
      // Skip when the filesystem cannot create a component of the requested length.
      skip("The environment cannot create a filesystem component of the requested length.");
      return;
    }
    const asset = assetFromDocument(minimalDocument("long-basename"));
    const store = storeFor([{ rootId: "global", kind: "global", directory: root }]);

    const result = await store.save({ rootId: "global", relativePath, asset: asset.asset });

    expect(result.ok).toBe(true);
    expect(await readFile(probePath, "utf8")).toBe(asset.document);
  });
});
