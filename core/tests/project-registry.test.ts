import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectRegistry } from "../src/projects/registry.ts";
import { createJsonLogger } from "../src/logging/logger.ts";
import { startCore } from "../src/index.ts";

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Project Registry reconciliation", () => {
  it("binds a pending entry when its marker exists at Core startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "aacl-registry-test-"));
    scratch.push(root);
    const projectRoot = join(root, "project");
    const registryPath = join(root, "state", "project-registry.json");
    await mkdir(join(projectRoot, ".aacl"), { recursive: true });
    await writeFile(join(projectRoot, ".aacl", "project.json"), JSON.stringify({
      schemaVersion: 1,
      projectId: "project-one",
    }), "utf8");
    await mkdir(join(root, "state"));
    await writeFile(registryPath, JSON.stringify({
      schemaVersion: 1,
      entries: [{
        workspacePath: projectRoot,
        projectRoot,
        projectId: "project-one",
        state: "pending",
      }],
    }), "utf8");

    const result = await createProjectRegistry(registryPath).reconcile();

    expect(result).toEqual({ ok: true, value: undefined });
    const document = JSON.parse(await readFile(registryPath, "utf8")) as any;
    expect(document.entries[0].state).toBe("bound");
  });

  it("refuses a malformed durable registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "aacl-registry-test-"));
    scratch.push(root);
    const registryPath = join(root, "project-registry.json");
    await writeFile(registryPath, "{}\n", "utf8");

    const result = await createProjectRegistry(registryPath).reconcile();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected invalid registry");
    expect(result.failure.details?.[0]?.code).toBe("invalid_registry");
  });

  it("reconciles the durable registry before Core starts listening", async () => {
    const root = await mkdtemp(join(tmpdir(), "aacl-registry-test-"));
    scratch.push(root);
    const registryPath = join(root, "project-registry.json");
    await writeFile(registryPath, "{}\n", "utf8");

    const outcome = await startCore({
      env: { AACL_CORE_PORT: "0" },
      logger: createJsonLogger(() => undefined, () => new Date()),
      projectRegistryPath: registryPath,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) await outcome.close();
  });
});
