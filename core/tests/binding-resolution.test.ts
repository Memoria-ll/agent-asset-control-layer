import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCapabilityCatalog,
  buildMetadataCatalog,
  validateCapabilityContext,
  type AssetResult,
  type CapabilityId,
  type CapabilityResolutionContext,
} from "@aacl/core-domain";
import { parseBindingResolutionResponse, type ModelId, type ProviderId, type RoleId, type TaskTypeId } from "@aacl/shared";
import {
  createProjectRegistry,
  createProjectService,
  resolveBindingAssets,
  resolveSelectedStageRequirements,
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

const makeFixture = async (): Promise<{
  readonly root: string;
  readonly globalRoot: SharedManagedAssetRoot;
  readonly personalRoot: SharedManagedAssetRoot;
  readonly service: ProjectService;
}> => {
  const root = await mkdtemp(join(tmpdir(), "aacl-binding-resolution-"));
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
    service: createProjectService({
      registry: createProjectRegistry(registryPath),
      newProjectSuffix: () => "test",
    }),
  };
};

const catalog = unwrap(buildMetadataCatalog({
  revision: "catalog-revision" as never,
  roles: [
    { roleId: "reviewer" as RoleId, displayName: "Reviewer" },
    { roleId: "implementer" as RoleId, displayName: "Implementer" },
  ],
  taskTypes: [{ taskTypeId: "code-review" as TaskTypeId, displayName: "Code review" }],
  providers: [{ providerId: "openai" as ProviderId, displayName: "OpenAI" }],
  runtimes: [],
  models: [{ modelId: "gpt-5" as ModelId, displayName: "GPT-5", providerId: "openai" as ProviderId }],
  roleModelRelations: [],
}));

const capabilities = (
  permission?: "allowed" | "denied",
): CapabilityResolutionContext => {
  const capabilityCatalog = unwrap(buildCapabilityCatalog(permission === undefined ? [] : [
    { capabilityId: "filesystem-read" as CapabilityId, displayName: "Filesystem read", features: [] },
  ]));
  return unwrap(validateCapabilityContext({
    catalog: capabilityCatalog,
    offers: permission === undefined ? [] : [{ capabilityId: "filesystem-read" as CapabilityId, features: [], permission }],
  }));
};

const request = (workspaceFolder?: string) => ({
  context: {
    executionMode: "advisory_preparation",
    workflow: { kind: "none" },
    roleId: "reviewer",
  },
  ...(workspaceFolder === undefined ? {} : { ide: { workspaceFolder } }),
});

const binding = (
  id: string,
  options: {
    readonly operation?: "add" | "override" | "disable";
    readonly capability?: "required";
    readonly body?: string;
    readonly tier?: "core" | "discoverable" | "on-demand";
    readonly fallbackFor?: string;
  } = {},
): string => `---
schema-version: 4
id: ${id}
type: binding
tier: ${options.tier ?? "core"}
operation: ${options.operation ?? "add"}
${options.capability === undefined ? "" : `capability.required: [${options.capability === "required" ? "filesystem-read" : ""}]\n`}scope.role: [reviewer]
${options.operation === "disable" ? "" : `metadata.target-kind: model\nmetadata.model-id: gpt-5\n${options.fallbackFor === undefined ? "" : `metadata.fallback-for: ${options.fallbackFor}\n`}`}---
${options.body ?? id}
`;

const workflow = (): string => [
  "---",
  "schema-version: 3",
  "id: review-flow",
  "type: workflow",
  "tier: core",
  "operation: add",
  "---",
  "```aacl-workflow",
  JSON.stringify({
    entryRoleId: "reviewer",
    entryStageId: "review",
    terminalStageId: "done",
    stages: [
      {
        stageId: "review",
        displayName: "Review",
        description: "Review the change",
        requiredRoleId: "reviewer",
        requiredTaskTypeId: "code-review",
      },
      { stageId: "done", displayName: "Done", description: "Finish" },
    ],
    transitions: [{ fromStageId: "review", toStageId: "done", transitionKind: "advance" }],
  }),
  "```",
  "",
].join("\n");

const write = async (directory: string, name: string, document: string): Promise<void> => {
  await writeFile(join(directory, name), document, "utf8");
};

const resolve = (
  fixture: Awaited<ReturnType<typeof makeFixture>>,
  input: unknown,
  capabilityContext: CapabilityResolutionContext = capabilities(),
) => resolveBindingAssets(input, {
  roots: [fixture.globalRoot, fixture.personalRoot],
  projectService: fixture.service,
  capabilityContext,
}, catalog);

describe("Core Binding resolution", () => {
  it("keeps Global and Project same-ID overlay candidates paired with public sources", async () => {
    const fixture = await makeFixture();
    const projectRoot = join(fixture.root, "project");
    await mkdir(projectRoot);
    const project = unwrap(await fixture.service.initialize(projectRoot));
    await write(fixture.globalRoot.directory, "global.md", binding("same-id", { body: "global" }));
    await write(join(projectRoot, ".aacl"), "project.md", binding("same-id", { operation: "override", body: "project" }));

    const response = unwrap(await resolve(fixture, request(projectRoot)));
    expect(response.candidates).toHaveLength(2);
    expect(response.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "add", applicability: expect.objectContaining({ kind: "overridden" }), source: { layer: "global" } }),
      expect.objectContaining({ operation: "override", applicability: expect.objectContaining({ kind: "included" }), source: { layer: "project", projectId: project.projectId } }),
    ]));
    expect(response.candidates.every((candidate) => !Object.hasOwn(candidate.source, "rootId"))).toBe(true);
    expect(response.candidates.every((candidate) => !Object.hasOwn(candidate.source, "sourceId"))).toBe(true);
  });

  it("keeps all eligible role bindings without a winner or assignment", async () => {
    const fixture = await makeFixture();
    await write(fixture.globalRoot.directory, "first.md", binding("first"));
    await write(fixture.globalRoot.directory, "second.md", binding("second"));

    const response = unwrap(await resolve(fixture, request()));
    expect(parseBindingResolutionResponse(response)).toEqual(response);
    expect(response.candidates.filter((candidate) => candidate.applicability.kind === "included")).toHaveLength(2);
    expect(response.candidates.every((candidate) => !Object.hasOwn(candidate, "winner"))).toBe(true);
    expect(response.candidates.every((candidate) => !Object.hasOwn(candidate, "assignment"))).toBe(true);
  });

  it.each([
    ["allowed", capabilities("allowed"), "included"],
    ["denied", capabilities("denied"), "unavailable"],
    ["missing", capabilities(), "unavailable"],
  ] as const)("routes required capability %s through resolveAssets", async (_name, capabilityContext, kind) => {
    const fixture = await makeFixture();
    await write(fixture.globalRoot.directory, "capability.md", binding("capability", { capability: "required" }));

    const response = unwrap(await resolve(fixture, request(), capabilityContext));
    expect(response.candidates[0]?.applicability.kind).toBe(kind);
    if (kind === "unavailable") {
      expect(response.candidates[0]?.applicability).toMatchObject({
        detail: { cause: capabilityContext.offers[0]?.permission === "denied" ? "capability_not_allowed" : "capability_unavailable" },
      });
    }
  });

  it("diagnoses and excludes a malformed Binding while a valid Binding resolves", async () => {
    const fixture = await makeFixture();
    await write(fixture.globalRoot.directory, "valid.md", binding("valid"));
    await write(fixture.globalRoot.directory, "malformed.md", `---
schema-version: 4
id: malformed
type: binding
tier: core
operation: add
scope.role: [reviewer]
---
malformed
`);

    const response = unwrap(await resolve(fixture, request()));
    expect(response.candidates).toHaveLength(1);
    expect(response.candidates[0]).toMatchObject({ applicability: { kind: "included" }, definition: { bindingId: "valid" } });
    expect(response.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "missing_field", path: ["root", "global", "file", "malformed.md", "frontmatter", "metadata.target-kind"] }),
    ]));
  });

  it("resolves fallback relations before applying the requested loading tiers", async () => {
    const fixture = await makeFixture();
    await write(fixture.globalRoot.directory, "primary.md", binding("primary", { tier: "discoverable" }));
    await write(fixture.globalRoot.directory, "fallback.md", binding("fallback", {
      tier: "core",
      fallbackFor: "primary",
    }));

    const response = unwrap(await resolveBindingAssets({ ...request(), loadingTiers: ["core"] }, {
      roots: [fixture.globalRoot, fixture.personalRoot],
      projectService: fixture.service,
      capabilityContext: capabilities(),
    }, catalog));

    expect(response.candidates).toHaveLength(1);
    expect(response.candidates[0]).toMatchObject({
      definition: { bindingId: "fallback" },
      fallbackRelation: { kind: "linked", primaryBindingId: "primary" },
      loadingTier: "core",
    });
  });

  it("resolves selected Stage requirements without applying them to Bindings", async () => {
    const fixture = await makeFixture();
    await write(fixture.globalRoot.directory, "review-flow.md", workflow());
    await write(fixture.globalRoot.directory, "reviewer.md", binding("reviewer-binding"));

    const selected = {
      context: {
        executionMode: "advisory_preparation",
        workflow: { kind: "selected", workflowId: "review-flow", stageId: "review" },
      },
    };
    const requirements = unwrap(await resolveSelectedStageRequirements(selected, {
      roots: [fixture.globalRoot, fixture.personalRoot],
      projectService: fixture.service,
      capabilityContext: capabilities(),
    }, catalog));
    const bindings = unwrap(await resolve(fixture, selected));

    expect(requirements.requirements).toEqual({
      workflowId: "review-flow",
      stageId: "review",
      requiredRoleId: "reviewer",
      requiredTaskTypeId: "code-review",
    });
    expect(bindings.context).not.toHaveProperty("roleId");
    expect(bindings.candidates[0]).toMatchObject({ applicability: { kind: "included" } });
  });
});
