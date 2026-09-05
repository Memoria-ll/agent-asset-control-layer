import { join } from "node:path";
import { tryParseResolveRequest, type ResolutionContextDto } from "@aacl/shared";
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
  /**
   * Fill context axes another Asset is the source of truth for. Runs on the
   * completed first match — which is what establishes the effective Asset,
   * overlays and scope included — and its result is matched again against the
   * same snapshot. `undefined` means nothing was added, so the first match
   * stands.
   */
  readonly deriveContext?: (
    context: ResolutionContextDto,
    resolved: ResolvedAssets,
  ) => AssetResult<ResolutionContextDto | undefined>;
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
  const matchScope = (against: typeof context) => resolveScope({
    context: against,
    snapshot: projection.snapshot,
    capabilityContext: options.capabilityContext,
    ...(options.contracts === undefined ? {} : { contracts: options.contracts }),
  });
  const first = matchScope(context);
  if (!first.ok) return first;

  // An axis another Asset owns is settled here, between the two things that
  // decide it: which Definition applies is a resolution question, and an axis
  // added after matching narrows nothing. Both runs read one `list()`, so the
  // Asset the axes come from and the Assets they narrow are the same files —
  // a second listing could resolve the two against different snapshots.
  let resolved = first;
  if (options.deriveContext !== undefined) {
    const derived = options.deriveContext(context, {
      resolution: first.value,
      assets: listed.assets,
      storeDiagnostics: listed.failures,
      projectionExclusions: projection.excluded,
    });
    if (!derived.ok) return derived;
    if (derived.value !== undefined) {
      const narrowed = matchScope(derived.value);
      if (!narrowed.ok) return narrowed;
      resolved = narrowed;
    }
  }

  // The requested loading tiers choose what is delivered, never what is resolved.
  // Nothing ties an overlay's tier to its target's, and `requires` crosses tiers
  // just as freely: filtering the snapshot first drops the issuer and silently
  // leaves the target included, or drops the target and reports an
  // operation_conflict against an asset the caller never asked about.  `outcome`
  // and `conflicts` stay unfiltered for the same reason — they describe the whole
  // resolution, and a conflict hidden because its assets sit in another tier reads
  // as a clean result.
  const loadingTiers = request.loadingTiers === undefined
    ? undefined
    : new Set(request.loadingTiers);
  const resolution = loadingTiers === undefined
    ? resolved.value
    : {
        ...resolved.value,
        evaluations: resolved.value.evaluations.filter(({ candidate }) =>
          loadingTiers.has(candidate.loadingTier)),
      };

  return {
    ok: true,
    value: {
      resolution,
      assets: listed.assets,
      storeDiagnostics: listed.failures,
      projectionExclusions: projection.excluded,
    },
  };
};
