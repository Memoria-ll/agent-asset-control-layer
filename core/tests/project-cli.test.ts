import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { parseProjectInfoDto } from "@aacl/shared";
import { runProjectCli } from "../src/project-cli.ts";

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const runProcess = (command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) =>
  new Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }>((resolveProcess, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolveProcess({ code, stdout, stderr }));
  });

describe("Project CLI", () => {
  it("initializes the selected root through the same Project service", async () => {
    const root = await mkdtemp(join(tmpdir(), "aacl-cli-test-"));
    scratch.push(root);
    const projectRoot = join(root, "monorepo", "packages", "app");
    const registryPath = join(root, "state", "project-registry.json");
    await mkdir(projectRoot, { recursive: true });
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runProjectCli(
      ["init", "packages/app"],
      join(root, "monorepo"),
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      registryPath,
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(parseProjectInfoDto(JSON.parse(stdout[0] ?? "null"))).toMatchObject({ projectRoot });
    await expect(readFile(join(root, "monorepo", ".aacl", "project.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(registryPath, "utf8"))).toMatchObject({ schemaVersion: 1 });
  });

  it("forwards an explicit root through the root project:init command", async () => {
    const root = await mkdtemp(join(tmpdir(), "aacl-cli-command-test-"));
    scratch.push(root);
    const projectRoot = join(root, "selected-project");
    const homeDirectory = join(root, "home");
    await mkdir(projectRoot);
    await mkdir(homeDirectory);

    const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const result = await runProcess(command, ["project:init", "--", projectRoot], resolve(process.cwd(), ".."), {
      ...process.env,
      HOME: homeDirectory,
      USERPROFILE: homeDirectory,
      COREPACK_HOME: process.env.COREPACK_HOME ?? join(homedir(), ".cache", "node", "corepack"),
    });

    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("Usage:");
    const jsonLine = result.stdout.trim().split(/\r?\n/).reverse().find((line) => line.startsWith("{"));
    expect(jsonLine).toBeDefined();
    expect(parseProjectInfoDto(JSON.parse(jsonLine ?? "null"))).toMatchObject({ projectRoot });
    await expect(readFile(join(projectRoot, ".aacl", "project.json"), "utf8")).resolves.toContain("project-");
  });

  it("reports usage without touching the filesystem", async () => {
    const lines: string[] = [];
    const exitCode = await runProjectCli([], "/", {
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(line),
    }, "/not-used/project-registry.json");
    expect(exitCode).toBe(2);
    expect(lines).toEqual(["Usage: pnpm project:init -- [project-root]"]);
  });
});
