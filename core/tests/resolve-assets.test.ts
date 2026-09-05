import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCapabilityCatalog,
  type AssetResult,
  type CapabilityId,
  type CapabilityResolutionContext,
} from "@aacl/core-domain";
import {
  createProjectRegistry,
  createProjectService,
  resolveAssets,
  type ProjectService,
  type SharedManagedAssetRoot,
} from "../src/index.ts";

const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const unwrap = <Value>(result: AssetResult<Value>): Value => {
  if (!result.ok) throw new Error(result.failure.message);
  return result.value;
};

const emptyCapabilities = (): CapabilityResolutionContext => ({
  catalog: unwrap(buildCapabilityCatalog([])),
  offers: [],
});

const makeFixture = async (): Promise<{
  readonly root: string;
  readonly globalRoot: SharedManagedAssetRoot;
  readonly personalRoot: SharedManagedAssetRoot;
  readonly registryPath: string;
  readonly service: ProjectService;
}> => {
  const root = await mkdtemp(join(tmpdir(), "aacl-resolve-assets-"));
  scratch.push(root);
  const globalDirectory = join(root, "global");
  const personalDirectory = join(root, "personal");
  await mkdir(globalDirectory);
  await mkdir(personalDirectory);
  const registryPath = join(root, "state", "project-registry.json");
  return {
    root,
    globalRoot: { rootId: "global", kind: "global", directory: globalDirectory },
    personalRoot: { rootId: "personal", kind: "personal", directory: personalDirectory },
    registryPath,
    service: createProjectService({
      registry: createProjectRegistry(registryPath),
      newProjectSuffix: () => "default",
    }),
  };
};

const request = (workspaceFolder?: string, projectId?: string, loadingTiers?: readonly string[]) => ({
  context: {
    executionMode: "advisory_preparation",
    workflow: { kind: "none" },
    ...(projectId === undefined ? {} : { projectId }),
  },
  ...(workspaceFolder === undefined ? {} : { ide: { workspaceFolder } }),
  ...(loadingTiers === undefined ? {} : { loadingTiers }),
});

const rule = (
  id: string,
  options: {
    readonly operation?: "add" | "override" | "disable";
    readonly tier?: "core" | "discoverable" | "on-demand";
    readonly projectId?: string;
    readonly mergeGroup?: string;
    readonly body?: string;
  } = {},
): string => `---
schema-version: 3
operation: ${options.operation ?? "add"}
id: ${id}
type: rule
tier: ${options.tier ?? "core"}
${options.projectId === undefined ? "" : `scope.project: [${options.projectId}]\n`}${options.mergeGroup === undefined ? "" : `merge-group: ${options.mergeGroup}\n`}---
${options.body ?? id}
`;

const writeAsset = async (directory: string, name: string, document: string): Promise<void> => {
  await writeFile(join(directory, name), document, "utf8");
};

const initializeProject = async (
  fixture: Awaited<ReturnType<typeof makeFixture>>,
  name: string,
  suffix: string,
): Promise<{ readonly root: string; readonly projectId: string }> => {
  const root = join(fixture.root, name);
  await mkdir(root);
  const service = createProjectService({
    registry: createProjectRegistry(fixture.registryPath),
    newProjectSuffix: () => suffix,
  });
  const initialized = unwrap(await service.initialize(root));
  return { root, projectId: initialized.projectId };
};

const resolve = (
  service: ProjectService,
  roots: readonly SharedManagedAssetRoot[],
  input: unknown,
  capabilityContext = emptyCapabilities(),
) => resolveAssets(input, { roots, projectService: service, capabilityContext });

describe("resolveAssets", () => {
  it("combines shared assets with only the discovered Project root", async () => {
    const fixture = await makeFixture();
    const projectA = await initializeProject(fixture, "project-a", "a");
    const projectB = await initializeProject(fixture, "project-b", "b");
    await writeAsset(fixture.globalRoot.directory, "global.md", rule("global-rule"));
    await writeAsset(join(projectA.root, ".aacl"), "local.md", rule("project-a-rule"));
    await writeAsset(join(projectB.root, ".aacl"), "local.md", rule("project-b-rule"));

    const service = createProjectService({ registry: createProjectRegistry(fixture.registryPath) });
    const roots = [fixture.globalRoot, fixture.personalRoot];
    const a = unwrap(await resolve(service, roots, request(projectA.root)));
    const b = unwrap(await resolve(service, roots, request(projectB.root)));

    expect(a.resolution.context.projectId).toBe(projectA.projectId);
    expect(new Set(a.resolution.evaluations.map(({ candidate }) => candidate.assetId))).toEqual(new Set([
      "global-rule",
      "project-a-rule",
    ]));
    expect(new Set(b.resolution.evaluations.map(({ candidate }) => candidate.assetId))).toEqual(new Set([
      "global-rule",
      "project-b-rule",
    ]));
  });

  it.each(["override", "disable"] as const)("applies a Project-local same-ID %s", async (operation) => {
    const fixture = await makeFixture();
    const project = await initializeProject(fixture, "project", "overlay");
    await writeAsset(fixture.globalRoot.directory, "target.md", rule("shared-rule", { mergeGroup: "shared" }));
    await writeAsset(join(project.root, ".aacl"), "overlay.md", rule("shared-rule", {
      operation,
      mergeGroup: "shared",
    }));
    const service = createProjectService({ registry: createProjectRegistry(fixture.registryPath) });

    const result = unwrap(await resolve(
      service,
      [fixture.globalRoot, fixture.personalRoot],
      request(project.root),
    ));
    const globalEvaluation = result.resolution.evaluations.find(({ candidate }) =>
      candidate.source.layer === "global");
    expect(globalEvaluation?.reason).toMatchObject(operation === "override"
      ? { kind: "overridden", overriddenBy: "shared-rule" }
      : { kind: "disabled", disabledBy: "shared-rule" });
  });

  it.each(["override", "disable"] as const)(
    "applies a Project-local %s whose loading tier the request excludes",
    async (operation) => {
      const fixture = await makeFixture();
      const project = await initializeProject(fixture, "project", "tier");
      await writeAsset(fixture.globalRoot.directory, "target.md", rule("shared-rule"));
      await writeAsset(join(project.root, ".aacl"), "overlay.md", rule("shared-rule", {
        operation,
        tier: "discoverable",
      }));
      const service = createProjectService({ registry: createProjectRegistry(fixture.registryPath) });

      const result = unwrap(await resolve(
        service,
        [fixture.globalRoot, fixture.personalRoot],
        request(project.root, undefined, ["core"]),
      ));

      expect(result.resolution.evaluations.map(({ candidate }) => candidate.loadingTier)).toEqual(["core"]);
      expect(result.resolution.evaluations[0]?.reason).toMatchObject(operation === "override"
        ? { kind: "overridden", overriddenBy: "shared-rule" }
        : { kind: "disabled", disabledBy: "shared-rule" });
    },
  );

  it("reads the latest shared Asset revision on every call", async () => {
    const fixture = await makeFixture();
    const path = join(fixture.globalRoot.directory, "changing.md");
    await writeAsset(fixture.globalRoot.directory, "changing.md", rule("changing", { body: "before" }));

    const first = unwrap(await resolve(
      fixture.service,
      [fixture.globalRoot, fixture.personalRoot],
      request(),
    ));
    await writeFile(path, rule("changing", { body: "after" }), "utf8");
    const second = unwrap(await resolve(
      fixture.service,
      [fixture.globalRoot, fixture.personalRoot],
      request(),
    ));

    expect(second.assets[0]?.revision).not.toBe(first.assets[0]?.revision);
    expect(second.assets[0]?.asset.body).toBe("after\n");
  });

  it("keeps an uninitialized workspace and Registry unchanged", async () => {
    const fixture = await makeFixture();
    await initializeProject(fixture, "registered", "registered");
    const workspace = join(fixture.root, "uninitialized");
    await mkdir(workspace);
    await writeAsset(fixture.globalRoot.directory, "global.md", rule("global-rule"));
    const registryBefore = await readFile(fixture.registryPath);

    const result = unwrap(await resolve(
      createProjectService({ registry: createProjectRegistry(fixture.registryPath) }),
      [fixture.globalRoot, fixture.personalRoot],
      request(workspace),
    ));

    expect(result.resolution.context.projectId).toBeUndefined();
    await expect(stat(join(workspace, ".aacl"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(fixture.registryPath)).toEqual(registryBefore);

    const unboundProject = await resolve(
      createProjectService({ registry: createProjectRegistry(fixture.registryPath) }),
      [fixture.globalRoot, fixture.personalRoot],
      request(workspace, "project-unbound"),
    );
    expect(unboundProject).toMatchObject({
      ok: false,
      failure: { code: "invalid_request", details: [{ code: "project_root_required" }] },
    });
  });

  it("rejects invalid discovery and Project identity conflicts", async () => {
    const fixture = await makeFixture();
    const invalidRoot = join(fixture.root, "invalid");
    await mkdir(join(invalidRoot, ".aacl"), { recursive: true });
    await writeFile(join(invalidRoot, ".aacl", "project.json"), "not-json", "utf8");
    const invalid = await resolve(fixture.service, [fixture.globalRoot], request(invalidRoot));
    expect(invalid).toMatchObject({ ok: false, failure: { code: "invalid_request" } });

    const project = await initializeProject(fixture, "project", "one");
    const service = createProjectService({ registry: createProjectRegistry(fixture.registryPath) });
    const requestMismatch = await resolve(
      service,
      [fixture.globalRoot],
      request(project.root, "project-other"),
    );
    expect(requestMismatch).toMatchObject({
      ok: false,
      failure: { code: "conflict", details: [{ code: "project_context_mismatch", path: ["context", "projectId"] }] },
    });

    await writeFile(join(project.root, ".aacl", "project.json"), JSON.stringify({
      schemaVersion: 1,
      projectId: "project-replaced",
    }), "utf8");
    const registryMismatch = await resolve(service, [fixture.globalRoot], request(project.root));
    expect(registryMismatch).toMatchObject({
      ok: false,
      failure: { code: "conflict", details: [{ code: "project_registry_mismatch" }] },
    });
  });

  it("supports Global-only resolution and rejects an unlocatable Project context", async () => {
    const fixture = await makeFixture();
    await writeAsset(fixture.globalRoot.directory, "global.md", rule("global-rule"));
    const globalOnly = unwrap(await resolve(fixture.service, [fixture.globalRoot], request()));
    expect(globalOnly.resolution.evaluations[0]?.candidate.assetId).toBe("global-rule");

    const missingWorkspace = await resolve(
      fixture.service,
      [fixture.globalRoot],
      request(undefined, "project-orphan"),
    );
    expect(missingWorkspace).toMatchObject({
      ok: false,
      failure: { code: "invalid_request", details: [{ path: ["context", "projectId"] }] },
    });
  });

  it("fails for a missing root but isolates file and projection diagnostics", async () => {
    const fixture = await makeFixture();
    const missing = await resolve(fixture.service, [{
      rootId: "missing",
      kind: "global",
      directory: join(fixture.root, "missing"),
    }], request());
    expect(missing).toMatchObject({
      ok: false,
      failure: { code: "invalid_request", details: [{ path: ["root", "missing"] }] },
    });

    await writeAsset(fixture.globalRoot.directory, "valid.md", rule("valid"));
    await writeFile(join(fixture.globalRoot.directory, "broken.md"), "---\nnot: valid\n---\n", "utf8");
    await writeAsset(fixture.globalRoot.directory, "global-disable.md", rule("global-disable", {
      operation: "disable",
      mergeGroup: "shared",
    }));
    const result = unwrap(await resolve(fixture.service, [fixture.globalRoot], request()));
    expect(result.resolution.evaluations.map(({ candidate }) => candidate.assetId)).toEqual(["valid"]);
    expect(result.storeDiagnostics).toHaveLength(1);
    expect(result.storeDiagnostics[0]?.source.relativePath).toBe("broken.md");
    expect(result.projectionExclusions).toHaveLength(1);
    expect(result.projectionExclusions[0]?.source.relativePath).toBe("global-disable.md");
  });

  it("applies loading tiers and the caller's capability context", async () => {
    const fixture = await makeFixture();
    await writeAsset(fixture.globalRoot.directory, "core.md", rule("core-rule"));
    await writeAsset(fixture.globalRoot.directory, "discoverable.md", rule("discoverable-rule", {
      tier: "discoverable",
    }));
    await writeAsset(fixture.globalRoot.directory, "capability.md", `---
schema-version: 3
operation: add
id: browser-skill
type: skill
tier: core
capability.required: [browser]
metadata.description: Browser dependent skill.
metadata.display-name: Browser skill
metadata.execution-mode: advisory_preparation
metadata.execution-permission: advisory-only
metadata.kind: advisory
metadata.workflow-relation: standalone
---
body
`);
    const catalog = unwrap(buildCapabilityCatalog([{
      capabilityId: "browser" as CapabilityId,
      displayName: "Browser",
      features: [],
    }]));
    const result = unwrap(await resolve(
      fixture.service,
      [fixture.globalRoot],
      request(undefined, undefined, ["core"]),
      { catalog, offers: [] },
    ));

    expect(result.resolution.evaluations.map(({ candidate }) => candidate.assetId)).toEqual([
      "browser-skill",
      "core-rule",
    ]);
    expect(result.resolution.evaluations.find(({ candidate }) =>
      candidate.assetId === "browser-skill")?.reason).toMatchObject({
      kind: "unavailable",
      cause: "capability_unavailable",
    });
    expect(result.assets.map(({ asset }) => asset.id)).toContain("discoverable-rule");
  });

  it("preserves request parser failures", async () => {
    const fixture = await makeFixture();
    const result = await resolve(fixture.service, [fixture.globalRoot], { context: {} });
    expect(result).toMatchObject({ ok: false, failure: { code: "invalid_request" } });
  });
});
