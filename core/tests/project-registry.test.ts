import { ChildProcess, execFileSync, spawn } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("uses the default marker observer child to bind a pending entry", async () => {
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

    expect(result).toEqual({ ok: true, value: { status: "complete" } });
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

  it("fails closed when the Registry lock path is not a regular file", async () => {
    const root = await mkdtemp(join(tmpdir(), "aacl-registry-test-"));
    scratch.push(root);
    const registryPath = join(root, "project-registry.json");
    await mkdir(`${registryPath}.lock`);

    const result = await createProjectRegistry(registryPath, {
      lock: { timeoutMs: 50, pollMs: 5 },
    }).reconcile();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected a lock path failure");
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
      const lockInfo = await lstat(`${registryPath}.lock`);
      expect(lockInfo.isFile()).toBe(true);

      const recovered = await createProjectRegistry(registryPath, {
        lock: { timeoutMs: 2_000, pollMs: 5 },
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

  it("times out while a live owner holds the native lock beyond the polling window", async () => {
    const root = await mkdtemp(join(tmpdir(), "aacl-registry-test-"));
    scratch.push(root);
    const registryPath = join(root, "project-registry.json");
    const heldWorkspace = join(root, "held");
    const waitingWorkspace = join(root, "waiting");
    await mkdir(heldWorkspace);
    await mkdir(waitingWorkspace);
    const owner = spawnRegistryWorker(registryPath, heldWorkspace, "project-held", 0, true);

    try {
      if (owner.stdout === null) throw new Error("Registry worker stdout is unavailable");
      await new Promise<void>((resolveReady, rejectReady) => {
        let output = "";
        const timeout = setTimeout(() => rejectReady(new Error("Registry worker did not acquire the lock")), 5000);
        owner.stdout?.setEncoding("utf8");
        owner.stdout?.on("data", (chunk: string) => {
          output += chunk;
          if (output.includes("locked\n")) {
            clearTimeout(timeout);
            resolveReady();
          }
        });
        owner.once("error", (error) => {
          clearTimeout(timeout);
          rejectReady(error);
        });
        owner.once("exit", () => {
          clearTimeout(timeout);
          rejectReady(new Error("Registry worker exited before holding the lock"));
        });
      });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_200));

      const waiting = await createProjectRegistry(registryPath, {
        lock: { timeoutMs: 75, pollMs: 5 },
      }).observe(waitingWorkspace, waitingWorkspace, createProjectMarkerDto("project-waiting").projectId);

      expect(waiting.ok).toBe(false);
      if (waiting.ok) throw new Error("Expected a live-owner lock timeout");
      expect(waiting.failure.details?.[0]?.code).toBe("lock_unavailable");
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) {
        owner.kill("SIGKILL");
        await waitForRegistryExit(owner);
      }
    }
  }, 10_000);

  it("keeps the permanent Registry lock file after a successful release", async () => {
    const root = await mkdtemp(join(tmpdir(), "aacl-registry-test-"));
    scratch.push(root);
    const registryPath = join(root, "project-registry.json");
    const workspace = join(root, "workspace");
    await mkdir(workspace);

    const result = await createProjectRegistry(registryPath).observe(
      workspace,
      workspace,
      createProjectMarkerDto("project-permanent-lock").projectId,
    );

    expect(result).toEqual({ ok: true, value: { status: "bound" } });
    const lockInfo = await lstat(`${registryPath}.lock`);
    expect(lockInfo.isFile()).toBe(true);
    expect(await readFile(`${registryPath}.lock`, "utf8")).toBe("");
  });

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

  it("returns degraded without partial persist when a FIFO-stalled observer child reaches its deadline", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "aacl-registry-test-"));
    scratch.push(root);
    const registryPath = join(root, "project-registry.json");
    const firstRoot = join(root, "first");
    const stalledRoot = join(root, "stalled");
    await mkdir(join(firstRoot, ".aacl"), { recursive: true });
    await writeFile(join(firstRoot, ".aacl", "project.json"), JSON.stringify({
      schemaVersion: 1,
      projectId: "project-first",
    }), "utf8");
    await mkdir(join(stalledRoot, ".aacl"), { recursive: true });
    execFileSync("mkfifo", [join(stalledRoot, ".aacl", "stall.fifo")]);
    const firstProjectId = createProjectMarkerDto("project-first").projectId;
    const stalledProjectId = createProjectMarkerDto("project-stalled").projectId;
    const document = JSON.stringify({
      schemaVersion: 1,
      entries: [
        {
          workspacePath: firstRoot,
          projectRoot: firstRoot,
          projectId: firstProjectId,
          state: "pending",
        },
        {
          workspacePath: stalledRoot,
          projectRoot: stalledRoot,
          projectId: stalledProjectId,
          state: "bound",
        },
      ],
    });
    await writeFile(registryPath, document, "utf8");

    const startedAt = Date.now();
    const registry = createProjectRegistry(registryPath, {
      markerReconciliationTimeoutMs: 500,
      markerObservationWorkerPath: fileURLToPath(new URL("./fixtures/marker-observer-stall.ts", import.meta.url)),
    });
    const unrefSpy = vi.spyOn(ChildProcess.prototype, "unref");
    try {
      const result = await registry.reconcile();
      expect(unrefSpy).toHaveBeenCalled();
      expect(Date.now() - startedAt).toBeLessThan(1_500);
      expect(result).toEqual({ ok: true, value: { status: "degraded", reason: "timeout" } });
    } finally {
      unrefSpy.mockRestore();
    }
    expect(await readFile(registryPath, "utf8")).toBe(document);
    const observerPid = Number(await readFile(join(stalledRoot, ".aacl", "observer.pid"), "utf8"));
    expect(Number.isInteger(observerPid)).toBe(true);
    let observerAlive = true;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        process.kill(observerPid, 0);
      } catch {
        observerAlive = false;
        break;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    expect(observerAlive).toBe(false);

    const followUp = await createProjectRegistry(registryPath).observe(
      firstRoot,
      firstRoot,
      firstProjectId,
    );
    expect(followUp).toEqual({ ok: true, value: { status: "bound" } });
  }, 5_000);

  it("classifies a marker observer child startup failure as unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "aacl-registry-test-"));
    scratch.push(root);
    const registryPath = join(root, "project-registry.json");
    const projectRoot = join(root, "project");
    await mkdir(projectRoot);
    const projectId = createProjectMarkerDto("project-child-failure").projectId;
    const document = JSON.stringify({
      schemaVersion: 1,
      entries: [{
        workspacePath: projectRoot,
        projectRoot,
        projectId,
        state: "bound",
      }],
    });
    await writeFile(registryPath, document, "utf8");

    const result = await createProjectRegistry(registryPath, {
      markerReconciliationTimeoutMs: 250,
      markerObservationWorkerPath: join(root, "missing-marker-observer.ts"),
    }).reconcile();

    expect(result).toEqual({ ok: true, value: { status: "complete" } });
    expect(await readFile(registryPath, "utf8")).toBe(document);
  });

  it("classifies malformed marker observer output as unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "aacl-registry-test-"));
    scratch.push(root);
    const registryPath = join(root, "project-registry.json");
    const projectRoot = join(root, "project");
    await mkdir(projectRoot);
    const projectId = createProjectMarkerDto("project-invalid-child").projectId;
    const document = JSON.stringify({
      schemaVersion: 1,
      entries: [{
        workspacePath: projectRoot,
        projectRoot,
        projectId,
        state: "bound",
      }],
    });
    await writeFile(registryPath, document, "utf8");

    const result = await createProjectRegistry(registryPath, {
      markerReconciliationTimeoutMs: 250,
      markerObservationWorkerPath: fileURLToPath(new URL("./fixtures/marker-observer-invalid.ts", import.meta.url)),
    }).reconcile();

    expect(result).toEqual({ ok: true, value: { status: "complete" } });
    expect(await readFile(registryPath, "utf8")).toBe(document);
  });

  it("warns and starts Core when reconciliation reaches its deadline", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "aacl-registry-test-"));
    scratch.push(root);
    const projectRoot = join(root, "project");
    const registryPath = join(root, "project-registry.json");
    await mkdir(join(projectRoot, ".aacl"), { recursive: true });
    execFileSync("mkfifo", [join(projectRoot, ".aacl", "stall.fifo")]);
    const projectId = createProjectMarkerDto("project-stalled").projectId;
    await writeFile(registryPath, JSON.stringify({
      schemaVersion: 1,
      entries: [{
        workspacePath: projectRoot,
        projectRoot,
        projectId,
        state: "bound",
      }],
    }), "utf8");
    const logLines: string[] = [];

    const outcome = await startCore({
      env: { AACL_CORE_PORT: "0" },
      logger: createJsonLogger((line) => logLines.push(line), () => new Date("2026-01-01T00:00:00.000Z")),
      projectRegistryPath: registryPath,
      projectRegistryOptions: {
        markerReconciliationTimeoutMs: 250,
        markerObservationWorkerPath: fileURLToPath(new URL("./fixtures/marker-observer-stall.ts", import.meta.url)),
      },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.failure.message);
    try {
      expect(JSON.parse(logLines[0] ?? "null")).toMatchObject({
        level: "warn",
        event: "core.project_registry_reconcile_degraded",
        reason: "timeout",
      });
      const response = await fetch(`http://${outcome.address.host}:${outcome.address.port}/health`);
      expect(response.status).toBe(200);
    } finally {
      await outcome.close();
    }
  }, 5_000);

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
      lock: { timeoutMs: 5_000, pollMs: 5 },
      beforeRename: async () => {
        await rm(`${registryPath}.lock`, { recursive: true, force: true });
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

  it("does not persist after the Registry lock is replaced before the final identity guard", async () => {
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
      lock: { timeoutMs: 5_000, pollMs: 5 },
      beforeRename: async () => {
        await rm(`${registryPath}.lock`, { recursive: true, force: true });
        await mkdir(`${registryPath}.lock`);
      },
    }).observe(secondWorkspace, secondWorkspace, secondProjectId);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected a replaced lock failure");
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
    const replacementLock = await lstat(`${registryPath}.lock`);
    expect(replacementLock.isDirectory()).toBe(true);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_250));
    const afterDelay = await lstat(`${registryPath}.lock`);
    expect(afterDelay.isDirectory()).toBe(true);
    expect(afterDelay.dev).toBe(replacementLock.dev);
    expect(afterDelay.ino).toBe(replacementLock.ino);
    expect(afterDelay.mtimeMs).toBe(replacementLock.mtimeMs);
  });

  it("releases the native lock after the critical section fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "aacl-registry-test-"));
    scratch.push(root);
    const registryPath = join(root, "project-registry.json");
    const workspace = join(root, "workspace");
    await mkdir(workspace);

    const result = await createProjectRegistry(registryPath, {
      beforeWrite: async () => {
        throw new Error("critical section failure");
      },
    }).observe(workspace, workspace, createProjectMarkerDto("project-native-release").projectId);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected the critical section to fail");
    expect(result.failure.details?.[0]?.code).toBe("lock_unavailable");

    const followUp = await createProjectRegistry(registryPath).observe(
      workspace,
      workspace,
      createProjectMarkerDto("project-native-release-follow-up").projectId,
    );
    expect(followUp).toEqual({ ok: true, value: { status: "bound" } });
    expect((await lstat(`${registryPath}.lock`)).isFile()).toBe(true);
  });

  it("keeps the permanent lock file when an out-of-protocol replacement is detected", async () => {
    const root = await mkdtemp(join(tmpdir(), "aacl-registry-test-"));
    scratch.push(root);
    const registryPath = join(root, "project-registry.json");
    const workspace = join(root, "workspace");
    await mkdir(workspace);

    const result = await createProjectRegistry(registryPath, {
      beforeRename: async () => {
        await rm(`${registryPath}.lock`, { force: true });
        await writeFile(`${registryPath}.lock`, "replacement", "utf8");
      },
    }).observe(workspace, workspace, createProjectMarkerDto("project-native-replacement").projectId);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected the replacement to compromise the lock");
    expect(result.failure.details?.[0]?.code).toBe("lock_unavailable");
    const replacement = await lstat(`${registryPath}.lock`);
    expect(replacement.isFile()).toBe(true);
    expect(await readFile(`${registryPath}.lock`, "utf8")).toBe("replacement");
  });

  it("does not delete an out-of-protocol replacement at process exit", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "aacl-registry-test-"));
    scratch.push(root);
    const registryPath = join(root, "project-registry.json");
    const lockPath = `${registryPath}.lock`;
    const fileLockModuleUrl = new URL("../src/internal/file-lock.ts", import.meta.url).href;
    const childScript = [
      "const [fileLockModuleUrl, lockPath] = process.argv.slice(1);",
      "const { withFileLock } = await import(fileLockModuleUrl);",
      "const { rm, mkdir } = await import(\"node:fs/promises\");",
      "await withFileLock(lockPath, async () => {",
      "  await rm(lockPath, { recursive: true, force: true });",
      "  await mkdir(lockPath);",
      "  process.exit(0);",
      "});",
    ].join("\n");
    const child = spawn(process.execPath, [
      "--input-type=module",
      "-e",
      childScript,
      fileLockModuleUrl,
      lockPath,
    ], {
      cwd: process.cwd(),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let errorOutput = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { errorOutput += chunk; });
    const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("exit", (code) => resolveExit(code));
    });

    expect(exitCode, errorOutput).toBe(0);
    const replacementLock = await lstat(lockPath);
    expect(replacementLock.isDirectory()).toBe(true);

    const probe = await createProjectRegistry(registryPath, {
      lock: { timeoutMs: 75, pollMs: 5 },
    }).reconcile();
    expect(probe.ok).toBe(false);
    if (probe.ok) throw new Error("Expected the replacement lock to remain owned");
    expect(probe.failure.details?.[0]?.code).toBe("lock_unavailable");
    const afterProbe = await lstat(lockPath);
    expect(afterProbe.isDirectory()).toBe(true);
    expect(afterProbe.dev).toBe(replacementLock.dev);
    expect(afterProbe.ino).toBe(replacementLock.ino);
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
    if (!outcome.ok) expect(outcome.stage).toBe("project-registry");
    if (outcome.ok) await outcome.close();
  });
});
