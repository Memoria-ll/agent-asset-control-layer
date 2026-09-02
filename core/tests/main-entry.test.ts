import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseVersionInfo } from "@aacl/shared";
import { coreFailure } from "@aacl/core-domain";
import { runMain } from "../src/main.ts";
import { createJsonLogger } from "../src/logging/logger.ts";
import type { StartOutcome } from "../src/index.ts";

const readFirstLine = (child: ReturnType<typeof spawn>): Promise<string> => {
  if (child.stdout === null) return Promise.reject(new Error("Child stdout is unavailable."));
  const stdout = child.stdout;

  return new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Core process did not log readiness."));
    }, 5000);
    const onData = (chunk: string | Buffer): void => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      cleanup();
      resolve(buffer.slice(0, newline));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (): void => {
      cleanup();
      reject(new Error("Core process exited before readiness."));
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };

    stdout.setEncoding("utf8");
    stdout.on("data", onData);
    child.on("error", onError);
    child.on("exit", onExit);
  });
};

const waitForExit = (child: ReturnType<typeof spawn>): Promise<void> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("Core process did not stop."));
    }, 5000);
    const onExit = (): void => {
      clearTimeout(timeout);
      resolve();
    };
    child.once("exit", onExit);
  });

const readOutputUntilExit = (child: ReturnType<typeof spawn>): Promise<string> => {
  if (child.stdout === null) return Promise.reject(new Error("Child stdout is unavailable."));
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Core process did not stop."));
    }, 5000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { output += chunk; });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve(output);
    });
  });
};

describe("Core main entry", () => {
  it("keeps the startup signal request until Core has finished starting", async () => {
    const logLines: string[] = [];
    let resolveStart!: (outcome: StartOutcome) => void;
    const startResult = new Promise<StartOutcome>((resolve) => {
      resolveStart = resolve;
    });
    let closed = false;
    const mainPromise = runMain(
      async () => startResult,
      createJsonLogger((line) => logLines.push(line), () => new Date("2026-01-01T00:00:00.000Z")),
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    process.emit("SIGTERM");
    resolveStart({
      ok: true,
      address: { host: "127.0.0.1", port: 7420 },
      close: async () => {
        closed = true;
      },
    });
    await mainPromise;

    expect(closed).toBe(true);
    const events = logLines.map((line) => (JSON.parse(line) as { event: string }).event);
    expect(events).not.toContain("core.listening");
    expect(events).not.toContain("core.listen_failed");
  });

  it("does not log a startup failure after a signal was requested", async () => {
    const logLines: string[] = [];
    let resolveStart!: (outcome: StartOutcome) => void;
    const startResult = new Promise<StartOutcome>((resolve) => {
      resolveStart = resolve;
    });
    const mainPromise = runMain(
      async () => startResult,
      createJsonLogger((line) => logLines.push(line), () => new Date("2026-01-01T00:00:00.000Z")),
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    process.emit("SIGINT");
    resolveStart({
      ok: false,
      stage: "project-registry",
      failure: coreFailure("unavailable", "startup unavailable"),
    });
    await mainPromise;

    const events = logLines.map((line) => (JSON.parse(line) as { event: string }).event);
    expect(events).not.toContain("core.project_registry_failed");
    expect(events).not.toContain("core.listening");
  });

  it("starts, serves health, and stops on SIGTERM", async () => {
    const testHome = await mkdtemp(join(tmpdir(), "aacl-main-entry-"));
    const child = spawn(process.execPath, ["src/main.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: testHome,
        USERPROFILE: testHome,
        AACL_CORE_HOST: "127.0.0.1",
        AACL_CORE_PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      const firstLine = JSON.parse(await readFirstLine(child)) as {
        event: string;
        host: string;
        port: number;
      };
      expect(firstLine.event).toBe("core.listening");
      expect(firstLine.port).toBeGreaterThan(0);

      const response = await fetch(`http://${firstLine.host}:${firstLine.port}/health`);
      expect(response.status).toBe(200);
      expect(parseVersionInfo(await response.json())).toHaveProperty("contractVersion");

      child.kill("SIGTERM");
      await waitForExit(child);
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await waitForExit(child);
      }
      await rm(testHome, { recursive: true, force: true });
    }
  });

  it("logs a Project Registry startup failure as its own stage", async () => {
    const testHome = await mkdtemp(join(tmpdir(), "aacl-main-entry-"));
    await mkdir(join(testHome, ".aacl-state"), { recursive: true });
    await writeFile(join(testHome, ".aacl-state", "project-registry.json"), "{}\n", "utf8");
    const child = spawn(process.execPath, ["src/main.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: testHome,
        USERPROFILE: testHome,
        AACL_CORE_HOST: "127.0.0.1",
        AACL_CORE_PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      const output = await readOutputUntilExit(child);
      const event = JSON.parse(output.trim()) as { event: string };
      expect(event.event).toBe("core.project_registry_failed");
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await waitForExit(child);
      }
      await rm(testHome, { recursive: true, force: true });
    }
  });
});
