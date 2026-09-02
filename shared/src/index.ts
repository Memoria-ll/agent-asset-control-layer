/**
 * The public contract shared by Core and the VS Code extension.
 *
 * This file is the whole published surface: the module layout behind it is
 * internal wiring, and the package publishes no subpath exports, so files can
 * be rearranged without breaking a consumer.
 *
 * **`zod` is an implementation detail of this package, not part of the
 * contract.** Nothing published here is a zod value: the surface is TypeScript
 * types, which vanish at build time, plus plain-JavaScript functions and data.
 * Two things follow, and both are the point rather than a side effect.
 *
 * `core` and `vscode-extension` can then declare no zod dependency, and that
 * missing dependency is what makes "the Extension does not redefine these DTOs"
 * hold by dependency resolution instead of by a reviewer noticing (#31/#46).
 * And the validation library stays replaceable: it was chosen on a measurement
 * (zod/mini at 16.7 KB against zod classic at 433 KB), and a package that had
 * welded its validator into every consumer could not act on the next one.
 *
 * When a consumer needs a runtime capability that is not here, this package
 * grows a named plain-JavaScript export for it — a `parse*` for a value it must
 * validate, an array for a set it must enumerate. Publishing the schemas
 * instead would answer every such need at once, at the cost of both properties
 * above.
 */

// ---------------------------------------------------------------------------
// Types. The whole DTO vocabulary, derived from the schemas inside the package.
// A consumer builds values with the `*Input` types and reads them as the parsed
// types; identifier brands are output-only, so a plain string is accepted
// wherever an input is built.
// ---------------------------------------------------------------------------

export type {
  NonEmptyString,
  Timestamp,
  TokenCount,
  AssetCount,
  DirectoryPath,
  SemanticVersion,
} from "./primitives.ts";

export type {
  AssetId,
  AssetRevision,
  ProjectId,
  RoleId,
  TaskTypeId,
  ProviderId,
  RuntimeId,
  ModelId,
  SessionId,
  AgentExecutionId,
  WorkflowId,
  ExecutionInstanceId,
  StageId,
  SnapshotId,
} from "./identifiers.ts";

export type {
  ResolutionReasonKind,
  AvailabilityStatus,
  DegradedInfo,
  ResolutionReason,
  ConflictDto,
} from "./status.ts";

export type {
  ProviderDto,
  RuntimeDto,
  ModelDto,
  ProviderDtoInput,
  RuntimeDtoInput,
  ModelDtoInput,
} from "./execution-targets.ts";

export type {
  RoleDto,
  TaskTypeDto,
  RoleDtoInput,
  TaskTypeDtoInput,
} from "./roles.ts";

export type {
  SessionDto,
  AgentExecutionDto,
  WorkflowBinding,
  WorkflowBindingInput,
  SessionDtoInput,
  AgentExecutionDtoInput,
} from "./sessions.ts";

export type {
  WorkflowDefinitionDto,
  WorkflowStageDto,
  WorkflowTransitionDto,
  WorkflowDefinitionDtoInput,
  WorkflowStageDtoInput,
  WorkflowTransitionDtoInput,
  WorkflowStateDto,
  TransitionCandidateDto,
  WorkflowStateDtoInput,
  TransitionCandidateDtoInput,
  TransitionKind,
  WorkflowStateVersion,
} from "./workflow.ts";

export type {
  AssetType,
  LoadingTier,
  ResolutionScopeInput,
  ResolvedAssetDto,
  ContextCostDto,
  ResolvedContextDto,
  ResolvedAssetDtoInput,
  ContextCostDtoInput,
  ResolvedContextDtoInput,
} from "./resolved-context.ts";

export type {
  IdeContextInput,
  ResolveRequest,
  ResolveResponse,
  ResolveRequestInput,
  ResolveResponseInput,
} from "./resolution.ts";

export type {
  CoreErrorCode,
  CoreErrorDetail,
  CoreErrorDto,
  ParseOutcome,
  CoreErrorDetailInput,
  CoreErrorDtoInput,
} from "./errors.ts";

export type {
  ContractVersion,
  VersionInfo,
  CompatibilityStatus,
  CompatibilityResult,
  VersionInfoInput,
} from "./contract-version.ts";

// ---------------------------------------------------------------------------
// Closed value sets, as plain arrays.
//
// A consumer rendering one control or label per member needs the list at run
// time, and reading it off a schema would mean both taking the zod dependency
// and reaching into `_zod` internals. Each array is the source of truth its
// schema is built from, so the two cannot drift.
// ---------------------------------------------------------------------------

export { ASSET_TYPES, LOADING_TIERS } from "./resolved-context.ts";
export { RESOLUTION_REASON_KINDS, AVAILABILITY_STATUSES } from "./status.ts";
export { CORE_ERROR_CODES } from "./errors.ts";
export { COMPATIBILITY_STATUSES } from "./contract-version.ts";
export { TRANSITION_KINDS } from "./workflow.ts";

// ---------------------------------------------------------------------------
// Boundary validation. One named entry point per DTO: `parse*` throws,
// `tryParse*` reports a `CoreErrorDto`. There is no generic parse — naming one
// function per DTO is what stops a consumer bringing its own schema.
// ---------------------------------------------------------------------------

export {
  parseProviderDto,
  tryParseProviderDto,
  parseRuntimeDto,
  tryParseRuntimeDto,
  parseModelDto,
  tryParseModelDto,
} from "./execution-targets.ts";

export {
  parseRoleDto,
  tryParseRoleDto,
  parseTaskTypeDto,
  tryParseTaskTypeDto,
} from "./roles.ts";

export {
  parseSessionDto,
  tryParseSessionDto,
  parseAgentExecutionDto,
  tryParseAgentExecutionDto,
} from "./sessions.ts";

export {
  parseWorkflowDefinitionDto,
  tryParseWorkflowDefinitionDto,
  parseWorkflowStateDto,
  tryParseWorkflowStateDto,
  parseTransitionCandidateDto,
  tryParseTransitionCandidateDto,
} from "./workflow.ts";

export {
  parseResolvedContextDto,
  tryParseResolvedContextDto,
} from "./resolved-context.ts";

export {
  parseResolveRequest,
  tryParseResolveRequest,
  parseResolveResponse,
  tryParseResolveResponse,
} from "./resolution.ts";

export { parseCoreErrorDto, tryParseCoreErrorDto } from "./errors.ts";

export { parseVersionInfo, tryParseVersionInfo } from "./contract-version.ts";

// ---------------------------------------------------------------------------
// Contract version, and the serialized form of every boundary type.
// ---------------------------------------------------------------------------

export {
  CONTRACT_VERSION,
  checkContractCompatibility,
} from "./contract-version.ts";

export { contractJsonSchemas } from "./json-schema.ts";
