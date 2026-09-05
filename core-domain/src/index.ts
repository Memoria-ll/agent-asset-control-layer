export { coreFailure, toCoreErrorDto } from "./failures.ts";
export type { AssetResult, CoreFailure } from "./failures.ts";

export {
  asBindingId,
  bindingAssetId,
  parseBindingAsset,
  parseBindingDocument,
  resolveBindings,
} from "./bindings.ts";
export type {
  CanonicalBinding,
  BindingResolutionInput,
  BindingResolutionEntry,
  BindingResolutionResult,
} from "./bindings.ts";

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
  SKILL_KINDS,
  SKILL_EXECUTION_PERMISSIONS,
  SKILL_WORKFLOW_RELATIONS,
  asSkillId,
  createSkillAsset,
  parseSkillAsset,
  projectSkillCandidate,
  skillAssetId,
  updateSkillAsset,
} from "./skill.ts";
export type {
  CanonicalSkill,
  SkillCandidateProjection,
  SkillExecutionPermission,
  SkillInput,
  SkillKind,
  SkillPatch,
  SkillResolutionDirectives,
  SkillWorkflowRelation,
  SkillWorkflowRelationKind,
} from "./skill.ts";

export { createWorkflowEntryReference } from "./workflow-entry.ts";
export type { WorkflowEntryReference } from "./workflow-entry.ts";

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

export { toResolutionContext, toValidatedResolutionContext } from "./resolution/resolution-context.ts";
export type { ResolutionContext, ValidatedExecutionContext } from "./resolution/resolution-context.ts";

export { DEFAULT_ASSET_TYPE_CONTRACTS } from "./resolution/asset-type-contracts.ts";
export type {
  AssetOperationKind,
  AssetTypeContract,
  AssetTypeContractRegistry,
  AssetTypeExecutionProfile,
  AssetTypeMergePolicy,
} from "./resolution/asset-type-contracts.ts";

export { toAssetCandidate } from "./resolution/asset-candidate-projection.ts";
export type { AssetProjectionSource } from "./resolution/asset-candidate-projection.ts";

export {
  buildCapabilityCatalog,
  evaluateCapabilityDependencies,
  featureSetContains,
  validateCapabilityContext,
} from "./capabilities/dependencies.ts";
export type {
  CapabilityCatalog,
  CapabilityDefinition,
  CapabilityDegradation,
  CapabilityDependency,
  CapabilityDependencyOutcome,
  CapabilityFeatureId,
  CapabilityId,
  CapabilityOffer,
  CapabilityReference,
  CapabilityResolutionContext,
} from "./capabilities/dependencies.ts";

export {
  resolveScope,
} from "./resolution/pipeline.ts";
export {
  toResolutionReasonDto,
  toResolutionConflictDto,
  toResolutionConflictDetails,
} from "./resolution/result-assembly.ts";
export type { ResolutionAxis } from "./resolution/resolution-context.ts";
export type {
  ResolutionSourceLayer,
  ResolutionSource,
  ResolutionOperation,
  ResolutionMerge,
  ResolutionRule,
  AssetCandidate,
  ResolutionSnapshot,
  ResolveScopeInput,
  ResolutionRank,
  CandidateReason,
  ResolutionConflict,
  ResolutionEvaluation,
  ResolutionResult,
} from "./resolution/resolution-types.ts";

export {
  applyWorkflowTransition,
  initializeWorkflowState,
  parseWorkflowDefinitionAsset,
  possibleWorkflowTransitions,
  validateWorkflowDefinition,
} from "./workflow.ts";
export type {
  ResolvedWorkflowDefinition,
  WorkflowEvaluationInput,
  WorkflowStateLinks,
  WorkflowStateMutation,
  WorkflowStateSeed,
  WorkflowTransitionSelection,
} from "./workflow.ts";

export {
  agentExecutionScope,
  toAgentExecutionDto,
  validateAgentExecutionReferences,
} from "./agent-execution.ts";
export type { AgentExecutionRecord } from "./agent-execution.ts";
