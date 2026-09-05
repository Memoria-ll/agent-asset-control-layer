import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFilesystemAssetStore,
  loadBinding,
  saveBinding,
} from "../src/index.ts";
import {
  parseBindingDocument,
  type AssetResult,
  type CanonicalBinding,
} from "@aacl/core-domain";
import type { BindingId } from "@aacl/shared";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const unwrap = <Value>(result: AssetResult<Value>): Value => {
  if (!result.ok) throw new Error(result.failure.message);
  return result.value;
};

const binding = (id: string, body = "model binding"): CanonicalBinding => unwrap(parseBindingDocument(`---
schema-version: 4
id: ${id}
type: binding
tier: core
operation: add
metadata.target-kind: model
metadata.model-id: gpt-5
---
${body}
`));

const disable = (id: string): CanonicalBinding => unwrap(parseBindingDocument(`---
schema-version: 4
id: ${id}
type: binding
tier: core
operation: disable
---
disable
`));

const exclusive = (id: string): CanonicalBinding => unwrap(parseBindingDocument(`---
schema-version: 4
id: ${id}
type: binding
tier: core
operation: add
merge-mode: exclusive
merge-group: reviewer
metadata.target-kind: model
metadata.model-id: gpt-5
---
exclusive
`));

const rule = (id: string): string => `---
schema-version: 3
id: ${id}
type: rule
tier: core
operation: add
---
rule
`;

const malformedBinding = (id: string): string => `---
schema-version: 4
id: ${id}
type: binding
tier: core
operation: add
---
malformed
`;

const makeStore = async () => {
  const directory = await mkdtemp(join(tmpdir(), "aacl-binding-store-"));
  temporaryDirectories.push(directory);
  const created = createFilesystemAssetStore([{ rootId: "global", kind: "global", directory }]);
  return { directory, store: unwrap(created) };
};

describe("filesystem Binding store", () => {
  it("refuses a project-only overlay before writing to a global root", async () => {
    const { directory, store } = await makeStore();
    const saved = await saveBinding(store, {
      rootId: "global",
      relativePath: "bindings/disable.md",
      asset: disable("reviewer-binding").asset,
    });
    expect(saved).toMatchObject({ ok: false, failure: { details: expect.arrayContaining([
      expect.objectContaining({ code: "operation_requires_project_source" }),
    ]) } });
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it("refuses a merge mode excluded by the Binding contract before writing", async () => {
    const { directory, store } = await makeStore();
    const saved = await saveBinding(store, {
      rootId: "global",
      relativePath: "exclusive.md",
      asset: exclusive("exclusive-binding").asset,
    });
    expect(saved).toMatchObject({ ok: false, failure: { details: expect.arrayContaining([
      expect.objectContaining({ code: "merge_mode_not_allowed" }),
    ]) } });
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it("saves, reloads, and preserves the stored revision and source", async () => {
    const { store } = await makeStore();
    const saved = await saveBinding(store, {
      rootId: "global",
      relativePath: "bindings/reviewer.md",
      asset: binding("reviewer-binding").asset,
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    const loaded = await loadBinding(store, "reviewer-binding" as BindingId);
    expect(loaded).toMatchObject({
      ok: true,
      value: {
        binding: { bindingId: "reviewer-binding", description: expect.stringContaining("model binding") },
        revision: saved.value.revision,
        source: { rootId: "global", kind: "global", relativePath: "bindings/reviewer.md" },
      },
    });
  });

  it("keeps stale expectedRevision as a conflict through the typed adapter", async () => {
    const { store } = await makeStore();
    const first = await saveBinding(store, {
      rootId: "global",
      relativePath: "binding.md",
      asset: binding("revisioned", "first").asset,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const updated = await saveBinding(store, {
      rootId: "global",
      relativePath: "binding.md",
      asset: binding("revisioned", "second").asset,
      expectedRevision: first.value.revision,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;

    const stale = await saveBinding(store, {
      rootId: "global",
      relativePath: "binding.md",
      asset: binding("revisioned", "stale").asset,
      expectedRevision: first.value.revision,
    });
    expect(stale).toMatchObject({ ok: false, failure: { code: "conflict" } });
  });

  it("classifies wrong-type, duplicate, and malformed Binding matches", async () => {
    const { directory, store } = await makeStore();
    await writeFile(join(directory, "wrong.md"), rule("wrong-type"), "utf8");
    const wrong = await loadBinding(store, "wrong-type" as BindingId);
    expect(wrong).toMatchObject({
      ok: false,
      failure: { code: "invalid_request", details: [{ path: ["root", "global", "file", "wrong.md", "asset", "type"] }] },
    });

    const savedDuplicate = await saveBinding(store, {
      rootId: "global", relativePath: "duplicate-a.md", asset: binding("duplicate").asset,
    });
    expect(savedDuplicate.ok).toBe(true);
    await writeFile(join(directory, "duplicate-b.md"), malformedBinding("duplicate"), "utf8");
    const duplicate = await loadBinding(store, "duplicate" as BindingId);
    expect(duplicate).toMatchObject({ ok: false, failure: { code: "conflict" } });

    await writeFile(join(directory, "malformed.md"), malformedBinding("malformed"), "utf8");
    const malformed = await loadBinding(store, "malformed" as BindingId);
    expect(malformed).toMatchObject({
      ok: false,
      failure: { code: "invalid_request", details: [{ path: ["root", "global", "file", "malformed.md", "frontmatter", "metadata.target-kind"] }] },
    });
  });
});
