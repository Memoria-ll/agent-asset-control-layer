/**
 * The public contract shared by Core and the VS Code extension.
 *
 * This file is the whole published surface: the module layout behind it is
 * internal wiring, and the package publishes no subpath exports, so files can
 * be rearranged without breaking a consumer.
 *
 * `zod` itself is not re-exported. Boundary validation is entered through the
 * `parse*` / `tryParse*` functions below, which is what lets `core` and
 * `vscode-extension` keep no direct dependency on a schema library — and that
 * missing dependency is what stops an ad-hoc redefinition of these DTOs from
 * compiling anywhere else.
 */

export {
  NonEmptyString,
  Timestamp,
  TokenCount,
  AssetCount,
  DirectoryPath,
  SemanticVersion,
} from "./primitives.js";

export {
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
  StageId,
  SnapshotId,
} from "./identifiers.js";

export {
  ResolutionReasonKind,
  AvailabilityStatus,
  DegradedInfo,
  ResolutionReason,
  ConflictDto,
} from "./status.js";

export {
  ProviderDto,
  RuntimeDto,
  ModelDto,
  parseProviderDto,
  tryParseProviderDto,
  parseRuntimeDto,
  tryParseRuntimeDto,
  parseModelDto,
  tryParseModelDto,
} from "./execution-targets.js";
export type {
  ProviderDtoInput,
  RuntimeDtoInput,
  ModelDtoInput,
} from "./execution-targets.js";

export {
  RoleDto,
  TaskTypeDto,
  parseRoleDto,
  tryParseRoleDto,
  parseTaskTypeDto,
  tryParseTaskTypeDto,
} from "./roles.js";
export type { RoleDtoInput, TaskTypeDtoInput } from "./roles.js";

export {
  SessionDto,
  AgentExecutionDto,
  parseSessionDto,
  tryParseSessionDto,
  parseAgentExecutionDto,
  tryParseAgentExecutionDto,
} from "./sessions.js";
export type { SessionDtoInput, AgentExecutionDtoInput } from "./sessions.js";

export {
  WorkflowStateDto,
  TransitionCandidateDto,
  parseWorkflowStateDto,
  tryParseWorkflowStateDto,
  parseTransitionCandidateDto,
  tryParseTransitionCandidateDto,
} from "./workflow.js";
export type {
  WorkflowStateDtoInput,
  TransitionCandidateDtoInput,
} from "./workflow.js";

export {
  AssetType,
  LoadingTier,
  ResolutionScopeInput,
  ResolvedAssetDto,
  ContextCostDto,
  ResolvedContextDto,
  parseResolvedContextDto,
  tryParseResolvedContextDto,
} from "./resolved-context.js";
export type {
  ResolvedAssetDtoInput,
  ContextCostDtoInput,
  ResolvedContextDtoInput,
} from "./resolved-context.js";

export {
  IdeContextInput,
  ResolveRequest,
  ResolveResponse,
  parseResolveRequest,
  tryParseResolveRequest,
  parseResolveResponse,
  tryParseResolveResponse,
} from "./resolution.js";
export type { ResolveRequestInput, ResolveResponseInput } from "./resolution.js";

export {
  CoreErrorCode,
  CoreErrorDetail,
  CoreErrorDto,
  toCoreError,
  parseCoreErrorDto,
  tryParseCoreErrorDto,
} from "./errors.js";
export type {
  ParseOutcome,
  CoreErrorDetailInput,
  CoreErrorDtoInput,
} from "./errors.js";

export {
  CONTRACT_VERSION,
  ContractVersion,
  VersionInfo,
  CompatibilityStatus,
  CompatibilityResult,
  checkContractCompatibility,
  parseVersionInfo,
  tryParseVersionInfo,
} from "./contract-version.js";
export type { VersionInfoInput } from "./contract-version.js";

export { contractSchemas, contractJsonSchemas } from "./json-schema.js";
