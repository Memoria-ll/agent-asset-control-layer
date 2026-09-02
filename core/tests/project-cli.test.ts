import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { parseProjectInfoDto } from "@aacl/shared";
import { runProjectCli } from "../src/project-cli.ts";

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
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
