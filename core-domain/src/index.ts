export { coreFailure, toCoreErrorDto } from "./failures.ts";
export type { AssetResult, CoreFailure } from "./failures.ts";

export {
  asAssetId,
  parseAssetDocument,
  serializeCanonicalAsset,
  validateAsset,
} from "./assets.ts";
export type {
  AssetFieldValue,
  AssetScopeAxis,
  CanonicalAsset,
  ParsedAssetDocument,
} from "./assets.ts";

export {
  buildMetadataCatalog,
  catalogRevisionInput,
  projectRoleDefinition,
  projectTaskTypeDefinition,
  toModelDto,
  toProviderDto,
  toRoleDto,
  toRuntimeDto,
  toTaskTypeDto,
} from "./catalog.ts";
export type {
  CatalogRevision,
  CatalogRevisionAssetPart,
  MetadataCatalog,
  MetadataCatalogInput,
  ModelDefinition,
  ProviderDefinition,
  RoleDefinition,
  RoleModelRelation,
  RuntimeDefinition,
  TaskTypeDefinition,
} from "./catalog.ts";

export { parseExecutionTargetCatalog } from "./catalog-document.ts";
export type { ExecutionTargetCatalogDocument } from "./catalog-document.ts";

export { toResolutionContext } from "./resolution-context.ts";
export type { ResolutionContext } from "./resolution-context.ts";

export {
  agentExecutionScope,
  toAgentExecutionDto,
  validateAgentExecutionReferences,
} from "./agent-execution.ts";
export type { AgentExecutionRecord } from "./agent-execution.ts";
