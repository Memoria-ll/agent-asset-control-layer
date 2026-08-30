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
 *
 * For the same reason no function published here takes a zod value as a
 * parameter: an argument a caller cannot construct without zod is an export it
 * cannot use. The entry points take `unknown` and return contract types.
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

/**
 * The registry itself stays internal. Its values are zod schemas, so walking it
 * to parse, render or compose is work only a package holding zod can do, and
 * `core` / `vscode-extension` hold none — publishing it would put the dependency
 * boundary back under review instead of under dependency resolution.
 *
 * A named DTO schema above is published on the opposite footing: it is the
 * declared source of truth for one boundary type and ships with its own
 * `parse*` / `tryParse*` entry point, which performs the zod work on the
 * consumer's behalf. `contractJsonSchemas()` is this registry's published
 * equivalent, and its keys enumerate the boundary types for anyone needing the
 * list.
 */
export { contractJsonSchemas } from "./json-schema.js";
