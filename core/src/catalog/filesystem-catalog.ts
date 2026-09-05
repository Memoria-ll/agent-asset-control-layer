import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  buildMetadataCatalog,
  catalogRevisionInput,
  parseExecutionTargetCatalog,
  projectRoleDefinition,
  projectTaskTypeDefinition,
  type AssetResult,
  type CanonicalAsset,
  type CatalogRevision,
  type MetadataCatalog,
  type RoleDefinition,
  type TaskTypeDefinition,
} from "@aacl/core-domain";
import { coreFailure, type CoreFailure } from "@aacl/core-domain";
import { unresolvedOperationFailure, withFilePath } from "../internal/diagnostics.ts";
import type { AssetDiagnostic } from "../assets/filesystem-store.ts";
import {
  createFilesystemAssetStore,
  type AssetStore,
  type ManagedAssetRoot,
  type StoredAsset,
} from "../assets/filesystem-store.ts";
import { sha256Hex } from "../internal/digest.ts";
import { strictDecode } from "../internal/text.ts";

/** The filesystem inputs used by the #3 resolver and #8 routing policy. */
export type MetadataCatalogSource = {
  /** The complete managed-root set from which the catalog is assembled. */
  readonly roots: readonly ManagedAssetRoot[];
  /** The absolute path of the dedicated catalog file. */
  readonly catalogFilePath: string;
};

/** The validated catalog or its classified load failure for #3 and #8. */
export type MetadataCatalogLoadResult =
  | { readonly ok: true; readonly catalog: MetadataCatalog; readonly assetDiagnostics: readonly AssetDiagnostic[] }
  | { readonly ok: false; readonly failure: CoreFailure; readonly assetDiagnostics: readonly AssetDiagnostic[] };

const errorCode = (error: unknown): string | undefined => {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
};

const catalogFileFailure = (error: unknown, catalogFilePath: string): CoreFailure => {
  const code = errorCode(error);
  if (code === "ENOENT") {
    return coreFailure("invalid_request", "The catalog file does not exist.", [
      { path: ["catalog", "file"], code: "catalog_file_missing", message: `The catalog file does not exist: ${catalogFilePath}.` },
    ]);
  }
  if (code === "EISDIR" || code === "ENOTDIR") {
    return coreFailure("invalid_request", "The catalog path does not identify a file.", [
      { path: ["catalog", "file"], code: "catalog_file_not_a_file", message: `The catalog path does not identify a file: ${catalogFilePath}.` },
    ]);
  }
  return coreFailure("unavailable", "The catalog file could not be read.", [
    { path: ["catalog", "file"], code: "unavailable", message: `The catalog file could not be read: ${catalogFilePath}.` },
  ]);
};

const catalogFileNotAFileFailure = (catalogFilePath: string): CoreFailure =>
  coreFailure("invalid_request", "The catalog path does not identify a file.", [
    { path: ["catalog", "file"], code: "catalog_file_not_a_file", message: `The catalog path does not identify a file: ${catalogFilePath}.` },
  ]);

const sourceLabel = (asset: StoredAsset): string =>
  `root "${asset.source.rootId}", file "${asset.source.relativePath}"`;

const duplicateSourceDetails = (
  failure: CoreFailure,
  roleAssets: readonly StoredAsset[],
  taskTypeAssets: readonly StoredAsset[],
): CoreFailure => {
  const details = (failure.details ?? []).map((item) => {
    const arrayName = item.path[1];
    const index = Number(item.path[2]);
    const assets = arrayName === "roles" ? roleAssets : arrayName === "taskTypes" ? taskTypeAssets : undefined;
    if (assets === undefined || !Number.isInteger(index) || assets[index] === undefined) return item;
    if (item.code !== "duplicate_role_id" && item.code !== "duplicate_task_type_id") return item;
    const current = assets[index];
    if (current === undefined) return item;
    const identifier = current.asset.id;
    const previous = assets.find((candidate, candidateIndex) => candidateIndex < index && candidate.asset.id === identifier);
    if (previous === undefined) return item;
    return {
      ...item,
      message: `${item.message} (${sourceLabel(previous)}; ${sourceLabel(current)}.)`,
    };
  });
  return coreFailure(failure.code, failure.message, details);
};

const buildFromStore = async (
  store: AssetStore,
  catalogFilePath: string,
): Promise<MetadataCatalogLoadResult> => {
  const listed = await store.list();
  const roleAssets = listed.assets.filter((stored) => stored.asset.type === "role");
  const taskTypeAssets = listed.assets.filter((stored) => stored.asset.type === "task-type");
  const roles: RoleDefinition[] = [];
  const taskTypes: TaskTypeDefinition[] = [];
  const projectionDetails: Array<{ readonly path: string[]; readonly code: string; readonly message: string }> = [];
  let projectionFailure: CoreFailure | undefined;

  // Projection failures are re-rooted at their file with the same helper the asset store
  // uses, so a defect in a role asset reads identically whichever reader found it.
  const collect = <Definition>(
    stored: StoredAsset,
    project: (asset: CanonicalAsset) => AssetResult<Definition>,
    into: Definition[],
  ): void => {
    const unresolvedOperation = unresolvedOperationFailure(stored.asset);
    const projected: AssetResult<Definition> = unresolvedOperation === undefined
      ? project(stored.asset)
      : { ok: false, failure: unresolvedOperation };
    if (projected.ok) {
      into.push(projected.value);
      return;
    }
    const located = withFilePath(stored.source.rootId, stored.source.relativePath, projected.failure);
    projectionFailure ??= located;
    projectionDetails.push(...(located.details ?? []));
  };
  for (const stored of roleAssets) collect(stored, projectRoleDefinition, roles);
  for (const stored of taskTypeAssets) collect(stored, projectTaskTypeDefinition, taskTypes);

  let catalogStats;
  try {
    catalogStats = await stat(catalogFilePath);
  } catch (error) {
    return { ok: false, failure: catalogFileFailure(error, catalogFilePath), assetDiagnostics: listed.failures };
  }
  if (!catalogStats.isFile()) {
    return { ok: false, failure: catalogFileNotAFileFailure(catalogFilePath), assetDiagnostics: listed.failures };
  }

  let sourceBytes: Buffer;
  try {
    sourceBytes = await readFile(catalogFilePath);
  } catch (error) {
    return { ok: false, failure: catalogFileFailure(error, catalogFilePath), assetDiagnostics: listed.failures };
  }
  // A named catalog file is outside root traversal, so the root asset symlink defense does not apply.
  const decoded = strictDecode(sourceBytes, ["catalog", "file"], "catalog");
  if (!decoded.ok) {
    return { ok: false, failure: decoded.failure, assetDiagnostics: listed.failures };
  }
  const document = parseExecutionTargetCatalog(decoded.value);
  if (!document.ok) {
    return { ok: false, failure: document.failure, assetDiagnostics: listed.failures };
  }
  if (projectionDetails.length > 0) {
    return {
      ok: false,
      failure: coreFailure(
        projectionFailure?.code ?? "invalid_request",
        projectionFailure?.message ?? "The metadata catalog is invalid.",
        projectionDetails,
      ),
      assetDiagnostics: listed.failures,
    };
  }

  const revision = `sha256:${sha256Hex(catalogRevisionInput({
    document: document.value,
    assets: listed.assets
      .filter((stored) => stored.asset.type === "role" || stored.asset.type === "task-type")
      .map((stored) => ({
        type: stored.asset.type === "role" ? "role" : "task-type",
        id: stored.asset.id,
        revision: stored.revision,
      })),
  }))}` as CatalogRevision;
  const built = buildMetadataCatalog({
    revision,
    roles,
    taskTypes,
    providers: document.value.providers,
    runtimes: document.value.runtimes,
    models: document.value.models,
    roleModelRelations: document.value.roleModelRelations,
  });

  if (!built.ok) {
    const catalogFailure = duplicateSourceDetails(built.failure, roleAssets, taskTypeAssets);
    return {
      ok: false,
      failure: catalogFailure,
      assetDiagnostics: listed.failures,
    };
  }
  return { ok: true, catalog: built.value, assetDiagnostics: listed.failures };
};

/** Load and validate the catalog consumed by the #3 resolver and #8 routing policy. */
export const loadMetadataCatalog = async (
  source: MetadataCatalogSource,
): Promise<MetadataCatalogLoadResult> => {
  if (typeof source.catalogFilePath !== "string" || !isAbsolute(source.catalogFilePath)) {
    return {
      ok: false,
      failure: coreFailure("invalid_request", "The catalog file path must be absolute.", [
        { path: ["catalog", "file"], code: "relative_catalog_path", message: "The catalog file path must be absolute." },
      ]),
      assetDiagnostics: [],
    };
  }
  const storeResult = createFilesystemAssetStore(source.roots);
  if (!storeResult.ok) return { ok: false, failure: storeResult.failure, assetDiagnostics: [] };
  return buildFromStore(storeResult.value, source.catalogFilePath);
};
