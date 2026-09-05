import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import {
  parseBindingResolutionResponse,
  type ModelId,
  type ProviderId,
  type RoleId,
  type TaskTypeId,
} from "@aacl/shared";
import {
  createProjectRegistry,
  createProjectService,
  resolveBindingAssets,
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
    readonly role?: string;
  } = {},
): string => `---
schema-version: 3
id: ${id}
type: binding
tier: ${options.tier ?? "core"}
operation: ${options.operation ?? "add"}
${options.capability === undefined ? "" : `capability.required: [${options.capability === "required" ? "filesystem-read" : ""}]\n`}scope.role: [${options.role ?? "reviewer"}]
${options.operation === "disable" ? "" : `metadata.target-kind: model\nmetadata.model-id: gpt-5\n${options.fallbackFor === undefined ? "" : `metadata.fallback-for: ${options.fallbackFor}\n`}`}---
${options.body ?? id}
`;

const workflowDocument = (
  options: {
    readonly operation?: "add" | "override";
    readonly requiredRoleId?: string;
    readonly model?: string;
  } = {},
): string => {
  const requiredRoleId = options.requiredRoleId ?? "reviewer";
  return [
    "---",
    "schema-version: 3",
    "id: review-flow",
    "type: workflow",
    "tier: core",
    `operation: ${options.operation ?? "add"}`,
    ...(options.model === undefined ? [] : [`scope.model: [${options.model}]`]),
    "---",
    "```aacl-workflow",
    JSON.stringify({
      entryRoleId: requiredRoleId,
      entryStageId: "review",
      terminalStageId: "done",
      stages: [
        {
          stageId: "review",
          displayName: "Review",
          description: "Review the change",
          requiredRoleId,
          requiredTaskTypeId: "code-review",
        },
        { stageId: "done", displayName: "Done", description: "Finish" },
      ],
      transitions: [{ fromStageId: "review", toStageId: "done", transitionKind: "advance" }],
    }),
    "```",
    "",
  ].join("\n");
};

const selectedStageRequest = () => ({
  context: {
    executionMode: "advisory_preparation",
    workflow: { kind: "selected", workflowId: "review-flow", stageId: "review" },
  },
});

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
      expect.objectContaining({ status: "unavailable", reasons: [{ kind: "binding_overridden", actorBindingId: "same-id" }], source: { layer: "global" } }),
      expect.objectContaining({ status: "eligible", source: { layer: "project", projectId: project.projectId } }),
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
    expect(response.candidates.filter((candidate) => candidate.status === "eligible")).toHaveLength(2);
    expect(response.candidates.every((candidate) => !Object.hasOwn(candidate, "winner"))).toBe(true);
    expect(response.candidates.every((candidate) => !Object.hasOwn(candidate, "assignment"))).toBe(true);
  });

  it.each([
    ["allowed", capabilities("allowed"), "eligible"],
    ["denied", capabilities("denied"), "unavailable"],
    ["missing", capabilities(), "unavailable"],
  ] as const)("routes required capability %s through resolveAssets", async (_name, capabilityContext, status) => {
    const fixture = await makeFixture();
    await write(fixture.globalRoot.directory, "capability.md", binding("capability", { capability: "required" }));

    const response = unwrap(await resolve(fixture, request(), capabilityContext));
    expect(response.candidates[0]?.status).toBe(status);
    if (status === "unavailable") {
      expect(response.candidates[0]?.reasons[0]?.kind).toBe(
        capabilityContext.offers[0]?.permission === "denied" ? "capability_not_allowed" : "capability_unavailable",
      );
    }
  });

  it("diagnoses and excludes a malformed Binding while a valid Binding resolves", async () => {
    const fixture = await makeFixture();
    await write(fixture.globalRoot.directory, "valid.md", binding("valid"));
    await write(fixture.globalRoot.directory, "malformed.md", `---
schema-version: 3
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
    expect(response.candidates[0]).toMatchObject({ status: "eligible", definition: { bindingId: "valid" } });
    expect(response.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "missing_field", path: ["root", "global", "file", "malformed.md", "frontmatter", "metadata.target-kind"] }),
    ]));
  });

  it("narrows candidates by the Role and Task Type the selected Stage requires", async () => {
    const fixture = await makeFixture();
    await write(fixture.globalRoot.directory, "review-flow.md", workflowDocument());
    await write(fixture.globalRoot.directory, "reviewer.md", binding("reviewer-binding", { role: "reviewer" }));
    await write(fixture.globalRoot.directory, "implementer.md", binding("implementer-binding", { role: "implementer" }));

    const response = unwrap(await resolve(fixture, selectedStageRequest()));

    expect(response.context).toMatchObject({ roleId: "reviewer", taskTypeId: "code-review" });
    expect(response.candidates.find((candidate) => candidate.definition?.bindingId === "reviewer-binding"))
      .toMatchObject({ status: "eligible" });
    expect(response.candidates.find((candidate) => candidate.definition?.bindingId === "implementer-binding"))
      .toMatchObject({ status: "unavailable", reasons: [{ kind: "scope_mismatch", axis: "roleId" }] });
  });

  it("derives the Stage axes from the Workflow the Project override makes effective", async () => {
    const fixture = await makeFixture();
    const projectRoot = join(fixture.root, "project");
    await mkdir(projectRoot);
    await fixture.service.initialize(projectRoot);
    await write(fixture.globalRoot.directory, "review-flow.md", workflowDocument());
    await write(join(projectRoot, ".aacl"), "review-flow.md", workflowDocument({
      operation: "override",
      requiredRoleId: "implementer",
    }));
    await write(fixture.globalRoot.directory, "reviewer.md", binding("reviewer-binding", { role: "reviewer" }));
    await write(fixture.globalRoot.directory, "implementer.md", binding("implementer-binding", { role: "implementer" }));

    const response = unwrap(await resolve(fixture, {
      ...selectedStageRequest(),
      ide: { workspaceFolder: projectRoot },
    }));

    // The override is the effective Definition, so its Stage's Role decides.
    expect(response.context).toMatchObject({ roleId: "implementer" });
    expect(response.candidates.find((candidate) => candidate.definition?.bindingId === "implementer-binding"))
      .toMatchObject({ status: "eligible" });
    expect(response.candidates.find((candidate) => candidate.definition?.bindingId === "reviewer-binding"))
      .toMatchObject({ status: "unavailable", reasons: [{ kind: "scope_mismatch", axis: "roleId" }] });
  });

  it("does not derive Stage axes from a Workflow the scope excludes", async () => {
    const fixture = await makeFixture();
    // Declares a Model the request's context does not carry, so scope matching
    // drops it — the Definition exists on disk but does not apply here.
    await write(fixture.globalRoot.directory, "review-flow.md", workflowDocument({ model: "other-model" }));
    await write(fixture.globalRoot.directory, "reviewer.md", binding("reviewer-binding", { role: "reviewer" }));

    const result = await resolve(fixture, {
      context: { ...selectedStageRequest().context, modelId: "gpt-5" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("not_found");
      expect(result.failure.details).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "workflow_definition_missing" }),
      ]));
    }
  });

  it("carries the read failure when the selected Workflow file cannot be read", async ({ skip }) => {
    if (process.platform === "win32") {
      skip("POSIX permission bits cannot reproduce this read failure on Windows.");
      return;
    }
    const fixture = await makeFixture();
    await write(fixture.globalRoot.directory, "review-flow.md", workflowDocument());
    await write(fixture.globalRoot.directory, "reviewer.md", binding("reviewer-binding"));
    const workflowPath = join(fixture.globalRoot.directory, "review-flow.md");
    await chmod(workflowPath, 0o000);

    let permissionDenied = false;
    try {
      await readFile(workflowPath);
    } catch (error) {
      permissionDenied = error !== null && typeof error === "object" && "code" in error
        && (error.code === "EACCES" || error.code === "EPERM");
    }
    if (!permissionDenied) {
      await chmod(workflowPath, 0o644);
      skip("The environment cannot reproduce a POSIX permission-denied read.");
      return;
    }

    const result = await resolve(fixture, selectedStageRequest());
    await chmod(workflowPath, 0o644);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The Workflow reads as absent, but the reason it is absent is the only
      // thing the caller can act on.
      expect(result.failure.details).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "unavailable",
          path: ["root", "global", "file", "review-flow.md"],
        }),
      ]));
    }
  });

  it("keeps a Role the caller supplied over the one the selected Stage requires", async () => {
    const fixture = await makeFixture();
    await write(fixture.globalRoot.directory, "review-flow.md", workflowDocument());
    await write(fixture.globalRoot.directory, "implementer.md", binding("implementer-binding", { role: "implementer" }));

    const response = unwrap(await resolve(fixture, {
      context: { ...selectedStageRequest().context, roleId: "implementer" },
    }));

    expect(response.context).toMatchObject({ roleId: "implementer", taskTypeId: "code-review" });
    expect(response.candidates.find((candidate) => candidate.definition?.bindingId === "implementer-binding"))
      .toMatchObject({ status: "eligible" });
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
      status: "unavailable",
      definition: { bindingId: "fallback" },
      reasons: [{ kind: "fallback_not_needed", primaryBindingId: "primary" }],
      loadingTier: "core",
    });
  });
});
