import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseVersionInfo } from "@aacl/shared";

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

describe("Core main entry", () => {
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
});
