import type {
  ModelDtoInput,
  ModelId,
  ProviderDtoInput,
  ProviderId,
  RoleDtoInput,
  RoleId,
  RuntimeDtoInput,
  RuntimeId,
  TaskTypeDtoInput,
  TaskTypeId,
} from "@aacl/shared";
import type { AssetFieldValue, CanonicalAsset } from "./assets.ts";
import { coreFailure, type AssetResult } from "./failures.ts";
import type { ExecutionTargetCatalogDocument } from "./catalog-document.ts";

/** A role definition projected from a canonical asset for #3 and #12. */
export type RoleDefinition = { readonly roleId: RoleId; readonly displayName: string };
/** A task-type definition projected from a canonical asset for #3 and #12. */
export type TaskTypeDefinition = { readonly taskTypeId: TaskTypeId; readonly displayName: string };
/** A provider definition read from the catalog file for #3 and #8. */
export type ProviderDefinition = { readonly providerId: ProviderId; readonly displayName: string };
/** A runtime definition read from the catalog file for #3 and #8. */
export type RuntimeDefinition = { readonly runtimeId: RuntimeId; readonly displayName: string; readonly providerId: ProviderId };
/** A model definition read from the catalog file for #3 and #8. */
export type ModelDefinition = { readonly modelId: ModelId; readonly displayName: string; readonly providerId: ProviderId };
/** A role/model association consumed by #8 routing policy. */
export type RoleModelRelation = { readonly roleId: RoleId; readonly modelId: ModelId };

/** A stable identity for the complete catalog contents, consumed by #3 and #8. */
declare const catalogRevisionBrand: unique symbol;
export type CatalogRevision = string & { readonly [catalogRevisionBrand]: true };

/** A validated catalog indexed for constant-time identifier lookup by #3 and #8. */
export type MetadataCatalog = {
  readonly revision: CatalogRevision;
  readonly roles: ReadonlyMap<RoleId, RoleDefinition>;
  readonly taskTypes: ReadonlyMap<TaskTypeId, TaskTypeDefinition>;
  readonly providers: ReadonlyMap<ProviderId, ProviderDefinition>;
  readonly runtimes: ReadonlyMap<RuntimeId, RuntimeDefinition>;
  readonly models: ReadonlyMap<ModelId, ModelDefinition>;
  readonly roleModelRelations: readonly RoleModelRelation[];
};

/** The definition arrays and revision used to construct a catalog for #3 and #8. */
export type MetadataCatalogInput = {
  readonly revision: CatalogRevision;
  readonly roles: readonly RoleDefinition[];
  readonly taskTypes: readonly TaskTypeDefinition[];
  readonly providers: readonly ProviderDefinition[];
  readonly runtimes: readonly RuntimeDefinition[];
  readonly models: readonly ModelDefinition[];
  readonly roleModelRelations: readonly RoleModelRelation[];
};

type Detail = { readonly path: string[]; readonly code: string; readonly message: string };

const detail = (path: readonly string[], code: string, message: string): Detail => ({
  path: [...path],
  code,
  message,
});

const invalidCatalog = (details: readonly Detail[]): AssetResult<never> => ({
  ok: false,
  failure: coreFailure("invalid_request", "The metadata catalog is invalid.", details),
});

const duplicateDetails = <T>(
  values: readonly T[],
  key: (value: T) => string,
  arrayName: string,
  fieldName: string,
  code: string,
): Detail[] => {
  const seen = new Set<string>();
  const details: Detail[] = [];
  for (const [index, value] of values.entries()) {
    const valueKey = key(value);
    if (seen.has(valueKey)) {
      details.push(detail(
        ["catalog", arrayName, String(index), fieldName],
        code,
        `Catalog identifier "${valueKey}" is declared more than once.`,
      ));
    } else {
      seen.add(valueKey);
    }
  }
  return details;
};

/** Build the validated catalog consumed by #3 and #8. */
export const buildMetadataCatalog = (input: MetadataCatalogInput): AssetResult<MetadataCatalog> => {
  const details: Detail[] = [
    ...duplicateDetails(input.roles, (value) => value.roleId, "roles", "roleId", "duplicate_role_id"),
    ...duplicateDetails(input.taskTypes, (value) => value.taskTypeId, "taskTypes", "taskTypeId", "duplicate_task_type_id"),
    ...duplicateDetails(input.providers, (value) => value.providerId, "providers", "providerId", "duplicate_provider_id"),
    ...duplicateDetails(input.runtimes, (value) => value.runtimeId, "runtimes", "runtimeId", "duplicate_runtime_id"),
    ...duplicateDetails(input.models, (value) => value.modelId, "models", "modelId", "duplicate_model_id"),
  ];

  const providers = new Map<ProviderId, ProviderDefinition>();
  for (const provider of input.providers) providers.set(provider.providerId, provider);
  const roles = new Map<RoleId, RoleDefinition>();
  for (const role of input.roles) roles.set(role.roleId, role);
  const taskTypes = new Map<TaskTypeId, TaskTypeDefinition>();
  for (const taskType of input.taskTypes) taskTypes.set(taskType.taskTypeId, taskType);
  const runtimes = new Map<RuntimeId, RuntimeDefinition>();
  for (const [index, runtime] of input.runtimes.entries()) {
    runtimes.set(runtime.runtimeId, runtime);
    if (!providers.has(runtime.providerId)) {
      details.push(detail(
        ["catalog", "runtimes", String(index), "providerId"],
        "unknown_provider_id",
        `Runtime provider "${runtime.providerId}" is not declared in the catalog.`,
      ));
    }
  }
  const models = new Map<ModelId, ModelDefinition>();
  for (const [index, model] of input.models.entries()) {
    models.set(model.modelId, model);
    if (!providers.has(model.providerId)) {
      details.push(detail(
        ["catalog", "models", String(index), "providerId"],
        "unknown_provider_id",
        `Model provider "${model.providerId}" is not declared in the catalog.`,
      ));
    }
  }

  const relationKeys = new Set<string>();
  for (const [index, relation] of input.roleModelRelations.entries()) {
    if (!roles.has(relation.roleId)) {
      details.push(detail(
        ["catalog", "roleModelRelations", String(index), "roleId"],
        "unknown_role_id",
        `Role "${relation.roleId}" is not declared in the catalog.`,
      ));
    }
    if (!models.has(relation.modelId)) {
      details.push(detail(
        ["catalog", "roleModelRelations", String(index), "modelId"],
        "unknown_model_id",
        `Model "${relation.modelId}" is not declared in the catalog.`,
      ));
    }
    const relationKey = JSON.stringify([relation.roleId, relation.modelId]);
    if (relationKeys.has(relationKey)) {
      details.push(detail(
        ["catalog", "roleModelRelations", String(index), "roleId"],
        "duplicate_role_model_relation",
        `Role/model relation "${relation.roleId}/${relation.modelId}" is declared more than once.`,
      ));
    } else {
      relationKeys.add(relationKey);
    }
  }

  if (details.length > 0) return invalidCatalog(details);
  return {
    ok: true,
    value: {
      revision: input.revision,
      roles,
      taskTypes,
      providers,
      runtimes,
      models,
      roleModelRelations: [...input.roleModelRelations],
    },
  };
};

const projectDefinition = (
  asset: CanonicalAsset,
  expectedType: "role" | "task-type",
): AssetResult<RoleDefinition | TaskTypeDefinition> => {
  if (asset.type !== expectedType) {
    return {
      ok: false,
      failure: coreFailure("invalid_request", `Asset type must be "${expectedType}".`, [
        detail(["document", "frontmatter", "type"], "wrong_asset_type", `Asset type must be "${expectedType}".`),
      ]),
    };
  }
  const value: AssetFieldValue | undefined = asset.metadata["display-name"];
  if (value === undefined) {
    return {
      ok: false,
      failure: coreFailure("invalid_request", "The asset is missing metadata.display-name.", [
        detail(["document", "frontmatter", "metadata.display-name"], "missing_display_name", "The asset is missing metadata.display-name."),
      ]),
    };
  }
  // The list case is discriminated by typeof, not Array.isArray: the latter narrows to
  // any[], which leaves readonly string[] in the union on the false branch, so the
  // scalar case never reaches string.
  if (typeof value !== "string") {
    return {
      ok: false,
      failure: coreFailure("invalid_request", "The display name must be a scalar string.", [
        detail(["document", "frontmatter", "metadata.display-name"], "invalid_value", "The display name must be a scalar string."),
      ]),
    };
  }
  // The asset id carries the AssetId brand, so it cannot go straight to RoleId or
  // TaskTypeId: two brands never overlap. Widening to string first drops the asset
  // brand and re-brands under the catalogue axis, which is the whole conversion —
  // the syntax the ids share is asserted by #2 and deliberately not re-checked here.
  return expectedType === "role"
    ? { ok: true, value: { roleId: asset.id as string as RoleId, displayName: value } }
    : { ok: true, value: { taskTypeId: asset.id as string as TaskTypeId, displayName: value } };
};

/** Project a canonical role asset for the #3 resolver and #12 API layer. */
export const projectRoleDefinition = (asset: CanonicalAsset): AssetResult<RoleDefinition> => {
  const result = projectDefinition(asset, "role");
  return result.ok ? { ok: true, value: result.value as RoleDefinition } : result;
};

/** Project a canonical task-type asset for the #3 resolver and #12 API layer. */
export const projectTaskTypeDefinition = (asset: CanonicalAsset): AssetResult<TaskTypeDefinition> => {
  const result = projectDefinition(asset, "task-type");
  return result.ok ? { ok: true, value: result.value as TaskTypeDefinition } : result;
};

/** Project a role definition into the DTO input consumed by #12 and #31. */
export const toRoleDto = (definition: RoleDefinition): RoleDtoInput => ({
  roleId: definition.roleId,
  displayName: definition.displayName,
});

/** Project a task-type definition into the DTO input consumed by #12 and #31. */
export const toTaskTypeDto = (definition: TaskTypeDefinition): TaskTypeDtoInput => ({
  taskTypeId: definition.taskTypeId,
  displayName: definition.displayName,
});

/** Project a provider definition into the DTO input consumed by #12 and #31. */
export const toProviderDto = (definition: ProviderDefinition): ProviderDtoInput => ({
  providerId: definition.providerId,
  displayName: definition.displayName,
});

/** Project a runtime definition into the DTO input consumed by #12 and #31. */
export const toRuntimeDto = (definition: RuntimeDefinition): RuntimeDtoInput => ({
  runtimeId: definition.runtimeId,
  displayName: definition.displayName,
  providerId: definition.providerId,
});

/** Project a model definition into the DTO input consumed by #12 and #31. */
export const toModelDto = (definition: ModelDefinition): ModelDtoInput => ({
  modelId: definition.modelId,
  displayName: definition.displayName,
  providerId: definition.providerId,
});

/** The role/task-type asset contribution to a catalog revision for #3 and #8. */
export type CatalogRevisionAssetPart = {
  readonly type: "role" | "task-type";
  readonly id: string;
  readonly revision: string;
};

/** Build the canonical, pre-hash revision input consumed by #3 and #8. */
export const catalogRevisionInput = (input: {
  readonly document: ExecutionTargetCatalogDocument;
  readonly assets: readonly CatalogRevisionAssetPart[];
}): string => {
  const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
  const providers = [...input.document.providers]
    .sort((left, right) => compare(left.providerId, right.providerId))
    .map(({ providerId, displayName }) => ({ providerId, displayName }));
  const runtimes = [...input.document.runtimes]
    .sort((left, right) => compare(left.runtimeId, right.runtimeId))
    .map(({ runtimeId, displayName, providerId }) => ({ runtimeId, displayName, providerId }));
  const models = [...input.document.models]
    .sort((left, right) => compare(left.modelId, right.modelId))
    .map(({ modelId, displayName, providerId }) => ({ modelId, displayName, providerId }));
  const relations = [...input.document.roleModelRelations]
    .sort((left, right) =>
      left.roleId === right.roleId ? compare(left.modelId, right.modelId) : compare(left.roleId, right.roleId))
    .map(({ roleId, modelId }) => ({ roleId, modelId }));
  const catalogJson = JSON.stringify({
    schemaVersion: input.document.schemaVersion,
    providers,
    runtimes,
    models,
    roleModelRelations: relations,
  });
  const assetLines = [...input.assets]
    .map((asset) => `${asset.type}\t${asset.id}\t${asset.revision}`)
    .sort(compare);
  return [`catalog\t${catalogJson}`, ...assetLines, ""].join("\n");
};
