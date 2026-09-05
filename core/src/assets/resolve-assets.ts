import { join } from "node:path";
import { tryParseResolveRequest } from "@aacl/shared";
import {
  coreFailure,
  resolveScope,
  type AssetResult,
  type AssetTypeContractRegistry,
  type CapabilityResolutionContext,
  type ResolutionResult,
} from "@aacl/core-domain";
import { PROJECT_DIRECTORY_NAME, type ProjectService } from "../projects/service.ts";
import {
  createFilesystemAssetStore,
  type AssetDiagnostic,
  type ManagedAssetRoot,
  type StoredAsset,
} from "./filesystem-store.ts";
import { toResolutionSnapshot } from "./resolution-input.ts";

export type SharedManagedAssetRoot = Extract<
  ManagedAssetRoot,
  { readonly kind: "global" | "personal" }
>;

export type ResolveAssetsOptions = {
  readonly roots: readonly SharedManagedAssetRoot[];
  readonly projectService: ProjectService;
  readonly capabilityContext: CapabilityResolutionContext;
  readonly contracts?: AssetTypeContractRegistry;
};

export type ResolvedAssets = {
  readonly resolution: ResolutionResult;
  readonly assets: readonly StoredAsset[];
  readonly storeDiagnostics: readonly AssetDiagnostic[];
  readonly projectionExclusions: readonly AssetDiagnostic[];
};

const detail = (path: readonly string[], code: string, message: string) => ({
  path: [...path],
  code,
  message,
});

const projectRootId = (projectId: string): string =>
  JSON.stringify(["aacl-project", projectId]);

export const resolveAssets = async (
  requestInput: unknown,
  options: ResolveAssetsOptions,
): Promise<AssetResult<ResolvedAssets>> => {
  const parsed = tryParseResolveRequest(requestInput);
  if (!parsed.ok) {
    return {
      ok: false,
      failure: coreFailure(parsed.error.code, parsed.error.message, parsed.error.details),
    };
  }

  const request = parsed.value;
  const workspaceFolder = request.ide?.workspaceFolder;
  let context = request.context;
  const roots: ManagedAssetRoot[] = [...options.roots];

  if (workspaceFolder === undefined) {
    if (context.projectId !== undefined) {
      const message = "A workspace folder is required to locate the requested Project assets.";
      return {
        ok: false,
        failure: coreFailure("invalid_request", message, [
          detail(["context", "projectId"], "project_root_required", message),
        ]),
      };
    }
  } else {
    const discovered = await options.projectService.discover(workspaceFolder);
    if (!discovered.ok) return discovered;

    const discovery = discovered.value;
    if (discovery.status === "invalid") {
      return {
        ok: false,
        failure: coreFailure(
          discovery.failure.code,
          discovery.failure.message,
          discovery.failure.details,
        ),
      };
    }
    if (discovery.status === "mismatch") {
      const message = "The Project Marker conflicts with the registered Project identity.";
      return {
        ok: false,
        failure: coreFailure("conflict", message, [
          detail(["projectMarker", "projectId"], "project_registry_mismatch", message),
        ]),
      };
    }
    if (discovery.status === "uninitialized" && context.projectId !== undefined) {
      const message = "The workspace does not identify the requested Project.";
      return {
        ok: false,
        failure: coreFailure("invalid_request", message, [
          detail(["context", "projectId"], "project_root_required", message),
        ]),
      };
    }
    if (discovery.status === "initialized") {
      if (context.projectId !== undefined && context.projectId !== discovery.projectId) {
        const message = "The requested Project does not match the discovered Project.";
        return {
          ok: false,
          failure: coreFailure("conflict", message, [
            detail(["context", "projectId"], "project_context_mismatch", message),
          ]),
        };
      }
      context = context.projectId === undefined
        ? { ...context, projectId: discovery.projectId }
        : context;
      roots.push({
        rootId: projectRootId(discovery.projectId),
        kind: "project",
        projectId: discovery.projectId,
        directory: join(discovery.projectRoot, PROJECT_DIRECTORY_NAME),
      });
    }
  }

  const storeResult = createFilesystemAssetStore(roots);
  if (!storeResult.ok) return storeResult;
  const listed = await storeResult.value.list();
  const rootFailure = listed.failures.find(({ source }) => source.relativePath === undefined);
  if (rootFailure !== undefined) return { ok: false, failure: rootFailure.failure };

  const projection = toResolutionSnapshot(listed.assets, options.contracts);
  const loadingTiers = request.loadingTiers === undefined
    ? undefined
    : new Set(request.loadingTiers);
  const snapshot = loadingTiers === undefined
    ? projection.snapshot
    : {
        candidates: projection.snapshot.candidates.filter((candidate) =>
          loadingTiers.has(candidate.loadingTier)),
      };
  const resolved = resolveScope({
    context,
    snapshot,
    capabilityContext: options.capabilityContext,
    ...(options.contracts === undefined ? {} : { contracts: options.contracts }),
  });
  if (!resolved.ok) return resolved;

  return {
    ok: true,
    value: {
      resolution: resolved.value,
      assets: listed.assets,
      storeDiagnostics: listed.failures,
      projectionExclusions: projection.excluded,
    },
  };
};
