import { lstat, mkdtemp, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { parseProjectMarkerDto } from "@aacl/shared";
import { createProjectRegistry, defaultProjectRegistryPath } from "../src/projects/registry.ts";
import { createProjectService } from "../src/projects/service.ts";

const scratch: string[] = [];

const makeScratch = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "aacl-project-test-"));
  scratch.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const setup = async (suffix = "fixed-id") => {
  const root = await makeScratch();
  const projectRoot = join(root, "project");
  const registryPath = join(root, "state", "project-registry.json");
  await mkdir(projectRoot);
  const registry = createProjectRegistry(registryPath);
  const service = createProjectService({ registry, newProjectSuffix: () => suffix });
  return { root, projectRoot, registryPath, registry, service };
};

describe("Project initialization and discovery", () => {
  it("initializes explicitly and remains idempotent", async () => {
    const { projectRoot, registryPath, service } = await setup();

    const first = await service.initialize(projectRoot);
    const second = await service.initialize(projectRoot);

    expect(first).toEqual({
      ok: true,
      value: { projectId: "project-fixed-id", projectRoot },
    });
    expect(second).toEqual(first);
    const marker = parseProjectMarkerDto(JSON.parse(
      await readFile(join(projectRoot, ".aacl", "project.json"), "utf8"),
    ));
    expect(marker).toEqual({ schemaVersion: 1, projectId: "project-fixed-id" });
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as any;
    expect(registry.entries).toEqual([{
      workspacePath: projectRoot,
      projectRoot,
      projectId: "project-fixed-id",
      state: "bound",
    }]);
  });

  it("rebinds the same marker identity after the workspace path moves", async () => {
    const { root, projectRoot, registryPath, service } = await setup();
    await service.initialize(projectRoot);
    const movedRoot = join(root, "moved-project");
    await rename(projectRoot, movedRoot);
    const nestedWorkspace = join(movedRoot, "packages", "one");
    await mkdir(nestedWorkspace, { recursive: true });

    const discovered = await service.discover(nestedWorkspace);

    expect(discovered).toEqual({
      ok: true,
      value: {
        status: "initialized",
        workspacePath: nestedWorkspace,
        projectRoot: movedRoot,
        projectId: "project-fixed-id",
      },
    });
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as any;
    expect(registry.entries.map((entry: any) => entry.projectId)).toEqual([
      "project-fixed-id",
      "project-fixed-id",
    ]);
    expect(registry.entries[1].workspacePath).toBe(movedRoot);
  });

  it("can explicitly initialize a nested Project after discovering its parent", async () => {
    const { projectRoot, registryPath, service } = await setup();
    await service.initialize(projectRoot);
    const nested = join(projectRoot, "packages", "one");
    await mkdir(nested, { recursive: true });
    await service.discover(nested);

    const nestedService = createProjectService({
      registry: createProjectRegistry(registryPath),
      newProjectSuffix: () => "nested-id",
    });
    const initialized = await nestedService.initialize(nested);

    expect(initialized).toEqual({
      ok: true,
      value: { projectId: "project-nested-id", projectRoot: nested },
    });
    expect(parseProjectMarkerDto(JSON.parse(
      await readFile(join(nested, ".aacl", "project.json"), "utf8"),
    )).projectId).toBe("project-nested-id");
  });

  it("leaves an uninitialized workspace untouched", async () => {
    const { projectRoot, registryPath, service } = await setup();

    expect(await service.discover(projectRoot)).toEqual({
      ok: true,
      value: { status: "uninitialized", workspacePath: projectRoot },
    });
    await expect(readFile(join(projectRoot, ".aacl", "project.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(registryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stops at the nearest invalid marker instead of falling through to a parent", async () => {
    const { projectRoot, service } = await setup();
    await service.initialize(projectRoot);
    const nested = join(projectRoot, "packages", "one");
    await mkdir(join(nested, ".aacl"), { recursive: true });
    await writeFile(join(nested, ".aacl", "project.json"), "not-json\n", "utf8");

    const discovered = await service.discover(nested);

    expect(discovered.ok).toBe(true);
    if (!discovered.ok) throw new Error(discovered.failure.message);
    expect(discovered.value.status).toBe("invalid");
    if (discovered.value.status !== "invalid") throw new Error("Expected invalid discovery");
    expect(discovered.value.projectRoot).toBe(nested);
    expect(discovered.value.failure.details?.[0]?.code).toBe("invalid_json");
  });

  it("reports a marker with an invalid identity instead of treating it as initialized", async () => {
    const { projectRoot, service } = await setup();
    await mkdir(join(projectRoot, ".aacl"), { recursive: true });
    await writeFile(join(projectRoot, ".aacl", "project.json"), JSON.stringify({
      schemaVersion: 1,
      projectId: "INVALID",
    }), "utf8");

    const discovered = await service.discover(projectRoot);

    expect(discovered.ok).toBe(true);
    if (!discovered.ok || discovered.value.status !== "invalid") {
      throw new Error("Expected invalid discovery");
    }
    expect(discovered.value.failure.details?.[0]?.code).toBe("invalid_marker");
  });

  it("records and reports a marker/registry mismatch without overwriting the registered identity", async () => {
    const { projectRoot, registryPath, service } = await setup();
    await service.initialize(projectRoot);
    await writeFile(join(projectRoot, ".aacl", "project.json"), JSON.stringify({
      schemaVersion: 1,
      projectId: "project-replaced",
    }), "utf8");

    const discovered = await service.discover(projectRoot);

    expect(discovered).toEqual({
      ok: true,
      value: {
        status: "mismatch",
        workspacePath: projectRoot,
        projectRoot,
        markerProjectId: "project-replaced",
        registryProjectId: "project-fixed-id",
      },
    });
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as any;
    expect(registry.entries[0]).toMatchObject({
      projectId: "project-fixed-id",
      markerProjectId: "project-replaced",
      state: "mismatch",
    });
  });

  it("recovers a pending binding from the marker on the next discovery", async () => {
    const { projectRoot, registryPath, registry } = await setup();
    const interrupted = createProjectService({
      registry,
      newProjectSuffix: () => "crash-id",
      afterMarkerWritten: async () => { throw new Error("simulated crash"); },
    });
    await expect(interrupted.initialize(projectRoot)).rejects.toThrow("simulated crash");
    let document = JSON.parse(await readFile(registryPath, "utf8")) as any;
    expect(document.entries[0].state).toBe("pending");

    const recovered = await createProjectService({ registry }).discover(projectRoot);

    expect(recovered).toEqual({
      ok: true,
      value: {
        status: "initialized",
        workspacePath: projectRoot,
        projectRoot,
        projectId: "project-crash-id",
      },
    });
    document = JSON.parse(await readFile(registryPath, "utf8")) as any;
    expect(document.entries[0].state).toBe("bound");
  });

  it("does not create .aacl when the Registry cannot be prepared", async () => {
    const root = await makeScratch();
    const projectRoot = join(root, "project");
    const registryPath = join(root, "state", "project-registry.json");
    await mkdir(projectRoot);
    await mkdir(join(root, "state"));
    await writeFile(registryPath, "{}\n", "utf8");
    const service = createProjectService({
      registry: createProjectRegistry(registryPath),
      newProjectSuffix: () => "registry-failure",
    });

    const result = await service.initialize(projectRoot);

    expect(result.ok).toBe(false);
    await expect(lstat(join(projectRoot, ".aacl"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replaces a stale bound entry with a newly generated identity", async () => {
    const { projectRoot, registryPath, service } = await setup();
    await service.initialize(projectRoot);
    await unlink(join(projectRoot, ".aacl", "project.json"));
    const retry = createProjectService({
      registry: createProjectRegistry(registryPath),
      newProjectSuffix: () => "replacement-id",
    });

    const result = await retry.initialize(projectRoot);

    expect(result).toEqual({
      ok: true,
      value: { projectId: "project-replacement-id", projectRoot },
    });
    const marker = parseProjectMarkerDto(JSON.parse(
      await readFile(join(projectRoot, ".aacl", "project.json"), "utf8"),
    ));
    expect(marker.projectId).toBe("project-replacement-id");
    const document = JSON.parse(await readFile(registryPath, "utf8")) as any;
    expect(document.entries[0]).toMatchObject({
      projectId: "project-replacement-id",
      state: "bound",
    });
  });

  it("keeps the global Registry outside the .aacl discovery sentinel", async () => {
    const home = await makeScratch();
    const projectRoot = join(home, "project");
    const siblingRoot = join(home, "sibling");
    await mkdir(projectRoot);
    await mkdir(siblingRoot);
    const service = createProjectService({
      registry: createProjectRegistry(defaultProjectRegistryPath(home)),
      newProjectSuffix: () => "home-project",
    });
    await service.initialize(projectRoot);

    const discovered = await service.discover(siblingRoot);

    expect(discovered).toEqual({
      ok: true,
      value: { status: "uninitialized", workspacePath: siblingRoot },
    });
  });

  it("rejects a random suffix outside the portable project-id alphabet", async () => {
    const { projectRoot, service } = await setup("UPPER_case");
    const result = await service.initialize(projectRoot);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected invalid suffix");
    expect(result.failure.details?.[0]?.code).toBe("invalid_project_id_suffix");
  });
});
