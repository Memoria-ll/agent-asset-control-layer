import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectMarkerDto } from "@aacl/shared";
import { createProjectRegistry } from "../src/projects/registry.ts";
import { createJsonLogger } from "../src/logging/logger.ts";
import { startCore } from "../src/index.ts";

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const registryWorkerScript = [
  "const [registryModuleUrl, registryPath, workspacePath, projectId, delayMs, hold] = process.argv.slice(1);",
  "const { createProjectRegistry } = await import(registryModuleUrl);",
  "const delay = Number(delayMs);",
  "const options = delay > 0 || hold === \"1\" ? { beforeWrite: async () => {",
  "  if (hold === \"1\") { process.stdout.write(\"locked\\n\"); setInterval(() => {}, 1000); await new Promise(() => {}); }",
  "  if (delay > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));",
  "} } : {};",
  "const registry = createProjectRegistry(registryPath, options);",
  "const result = await registry.observe(workspacePath, workspacePath, projectId);",
  "if (!result.ok) { console.error(result.failure.message); process.exitCode = 1; }",
].join("\n");

const spawnRegistryWorker = (
  registryPath: string,
  workspacePath: string,
  projectId: string,
  delayMs: number,
  hold = false,
) => {
  const registryModuleUrl = new URL("../src/projects/registry.ts", import.meta.url).href;
  return spawn(process.execPath, [
    "--input-type=module",
    "-e",
    registryWorkerScript,
    registryModuleUrl,
    registryPath,
    workspacePath,
    projectId,
    String(delayMs),
    hold ? "1" : "0",
  ], {
    cwd: process.cwd(),
    stdio: ["ignore", hold ? "pipe" : "ignore", "pipe"],
  });
};

const waitForRegistryWorker = (child: ReturnType<typeof spawn>): Promise<void> => new Promise((resolve, reject) => {
  let errorOutput = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { errorOutput += chunk; });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (code === 0) {
      resolve();
      return;
    }
    reject(new Error(`Registry worker failed (${code ?? signal}): ${errorOutput}`));
  });
});

const runRegistryWorker = (
  registryPath: string,
  workspacePath: string,
  projectId: string,
  delayMs: number,
): Promise<void> => waitForRegistryWorker(
  spawnRegistryWorker(registryPath, workspacePath, projectId, delayMs),
);

const waitForRegistryExit = (child: ReturnType<typeof spawn>): Promise<void> => new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", () => resolve());
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

  it("rejects a mismatch entry whose marker and registry IDs are equal", async () => {
    const root = await mkdtemp(join(tmpdir(), "aacl-registry-test-"));
    scratch.push(root);
    const projectRoot = join(root, "project");
    const registryPath = join(root, "project-registry.json");
    await mkdir(projectRoot);
    await writeFile(registryPath, JSON.stringify({
      schemaVersion: 1,
      entries: [{
        workspacePath: projectRoot,
        projectRoot,
        projectId: "project-same",
        state: "mismatch",
        markerProjectId: "project-same",
      }],
    }), "utf8");

    const result = await createProjectRegistry(registryPath).reconcile();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected invalid registry");
    expect(result.failure.details?.[0]?.code).toBe("invalid_registry");
  });

  it("rejects a FIFO Registry without opening it for reading", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "aacl-registry-test-"));
    scratch.push(root);
    const registryPath = join(root, "project-registry.json");
    execFileSync("mkfifo", [registryPath]);

    const result = await Promise.race([
      createProjectRegistry(registryPath).reconcile(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("FIFO read blocked")), 1000)),
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected a non-regular Registry failure");
    expect(result.failure.details?.[0]?.code).toBe("invalid_registry_file");
  });

  it("fails closed while another process owns the Registry lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "aacl-registry-test-"));
    scratch.push(root);
    const registryPath = join(root, "project-registry.json");
    await mkdir(`${registryPath}.lock`);

    const result = await createProjectRegistry(registryPath, {
      lock: { timeoutMs: 50, pollMs: 5 },
    }).reconcile();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected a lock timeout");
    expect(result.failure.details?.[0]?.code).toBe("lock_unavailable");
  });

  it("recovers a Registry lock after its owning process is killed", async () => {
    const root = await mkdtemp(join(tmpdir(), "aacl-registry-test-"));
    scratch.push(root);
    const registryPath = join(root, "project-registry.json");
    const crashedWorkspace = join(root, "crashed");
    const recoveredWorkspace = join(root, "recovered");
    await mkdir(crashedWorkspace);
    await mkdir(recoveredWorkspace);
    const crashed = spawnRegistryWorker(registryPath, crashedWorkspace, "project-crashed", 0, true);

    try {
      if (crashed.stdout === null) throw new Error("Registry worker stdout is unavailable");
      await new Promise<void>((resolveReady, rejectReady) => {
        let output = "";
        const timeout = setTimeout(() => rejectReady(new Error("Registry worker did not acquire the lock")), 5000);
        crashed.stdout?.setEncoding("utf8");
        crashed.stdout?.on("data", (chunk: string) => {
          output += chunk;
          if (output.includes("locked\n")) {
            clearTimeout(timeout);
            resolveReady();
          }
        });
        crashed.once("error", (error) => {
          clearTimeout(timeout);
          rejectReady(error);
        });
        crashed.once("exit", () => {
          clearTimeout(timeout);
          rejectReady(new Error("Registry worker exited before holding the lock"));
        });
      });
      crashed.kill("SIGKILL");
      await waitForRegistryExit(crashed);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2300));

      const recovered = await createProjectRegistry(registryPath, {
        lock: { timeoutMs: 10_000, pollMs: 20, staleMs: 2_000, updateMs: 1_000 },
      }).observe(recoveredWorkspace, recoveredWorkspace, createProjectMarkerDto("project-recovered").projectId);

      expect(recovered).toEqual({ ok: true, value: { status: "bound" } });
      const document = JSON.parse(await readFile(registryPath, "utf8")) as {
        entries: Array<{ workspacePath: string; projectId: string; state: string }>;
      };
      expect(document.entries).toEqual([{
        workspacePath: recoveredWorkspace,
        projectRoot: recoveredWorkspace,
        projectId: "project-recovered",
        state: "bound",
      }]);
    } finally {
      if (crashed.exitCode === null && crashed.signalCode === null) {
        crashed.kill("SIGKILL");
        await waitForRegistryExit(crashed);
      }
    }
  }, 15_000);

  it("preserves both Registry updates made by separate Core processes", async () => {
    const root = await mkdtemp(join(tmpdir(), "aacl-registry-test-"));
    scratch.push(root);
    const registryPath = join(root, "project-registry.json");
    const firstWorkspace = join(root, "first");
    const secondWorkspace = join(root, "second");
    await mkdir(firstWorkspace);
    await mkdir(secondWorkspace);

    const first = runRegistryWorker(registryPath, firstWorkspace, "project-first", 250);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    const second = runRegistryWorker(registryPath, secondWorkspace, "project-second", 0);
    await Promise.all([first, second]);

    const document = JSON.parse(await readFile(registryPath, "utf8")) as {
      entries: Array<{ workspacePath: string; projectId: string; state: string }>;
    };
    expect(document.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ workspacePath: firstWorkspace, projectId: "project-first", state: "bound" }),
      expect.objectContaining({ workspacePath: secondWorkspace, projectId: "project-second", state: "bound" }),
    ]));
    expect(document.entries).toHaveLength(2);
  });

  it("does not persist after the Registry lock is compromised", async () => {
    const root = await mkdtemp(join(tmpdir(), "aacl-registry-test-"));
    scratch.push(root);
    const registryPath = join(root, "project-registry.json");
    const firstWorkspace = join(root, "first");
    const secondWorkspace = join(root, "second");
    await mkdir(firstWorkspace);
    await mkdir(secondWorkspace);
    const firstProjectId = createProjectMarkerDto("project-first").projectId;
    const secondProjectId = createProjectMarkerDto("project-second").projectId;

    const initial = await createProjectRegistry(registryPath).observe(firstWorkspace, firstWorkspace, firstProjectId);
    expect(initial).toEqual({ ok: true, value: { status: "bound" } });

    const result = await createProjectRegistry(registryPath, {
      lock: { timeoutMs: 5_000, pollMs: 5, staleMs: 2_000, updateMs: 1_000 },
      beforeRename: async () => {
        await rm(`${registryPath}.lock`, { recursive: true, force: true });
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_500));
      },
    }).observe(secondWorkspace, secondWorkspace, secondProjectId);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected a compromised lock failure");
    expect(result.failure.details?.[0]?.code).toBe("lock_unavailable");
    const document = JSON.parse(await readFile(registryPath, "utf8")) as {
      entries: Array<{ workspacePath: string; projectId: string; state: string }>;
    };
    expect(document.entries).toEqual([{
      workspacePath: firstWorkspace,
      projectRoot: firstWorkspace,
      projectId: "project-first",
      state: "bound",
    }]);
  }, 10_000);

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
    if (!outcome.ok) expect(outcome.stage).toBe("project-registry");
    if (outcome.ok) await outcome.close();
  });
});
