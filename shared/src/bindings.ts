import * as z from "zod/mini";
import {
  AssetRevision,
  BindingId,
  ModelId,
  ProviderId,
  RoleId,
  RuntimeId,
  StageId,
  TaskTypeId,
  WorkflowId,
} from "./identifiers.ts";
import { CoreErrorDetail, tryParseWith, type ParseOutcome } from "./errors.ts";
import { IdeContextInput } from "./resolution.ts";
import { LoadingTier, ResolutionContextInput } from "./resolved-context.ts";
import { DirectoryPath, NonEmptyString } from "./primitives.ts";
import { ResolutionReason } from "./status.ts";
import { ProjectMarkerId } from "./projects.ts";

export const BINDING_TARGET_KINDS = [
  "provider",
  "runtime",
  "model",
  "runtime-model",
] as const;
export const BindingTargetKind = z.enum(BINDING_TARGET_KINDS);
export type BindingTargetKind = z.infer<typeof BindingTargetKind>;

export const BINDING_TARGET_AVAILABILITY_STATUSES = ["available", "unavailable"] as const;
export const BindingTargetAvailabilityStatus = z.enum(BINDING_TARGET_AVAILABILITY_STATUSES);
export type BindingTargetAvailabilityStatus = z.infer<typeof BindingTargetAvailabilityStatus>;

export const BINDING_TARGET_ISSUE_KINDS = [
  "target_missing",
  "target_provider_mismatch",
] as const;
export const BindingTargetIssueKind = z.enum(BINDING_TARGET_ISSUE_KINDS);
export type BindingTargetIssueKind = z.infer<typeof BindingTargetIssueKind>;

export const BINDING_FALLBACK_RELATION_KINDS = ["none", "linked", "missing", "cycle"] as const;
export const BindingFallbackRelationKind = z.enum(BINDING_FALLBACK_RELATION_KINDS);
export type BindingFallbackRelationKind = z.infer<typeof BindingFallbackRelationKind>;

export const BINDING_SCOPE_AXES = [
  "projectId",
  "workflowId",
  "stageId",
  "taskTypeId",
  "roleId",
  "providerId",
  "runtimeId",
  "modelId",
  "directory",
] as const;
export const BindingScopeAxis = z.enum(BINDING_SCOPE_AXES);
export type BindingScopeAxis = z.infer<typeof BindingScopeAxis>;

const uniqueNonEmpty = <Schema extends z.core.$ZodType>(schema: Schema) =>
  z.array(schema)
    .check(z.minLength(1))
    .check(z.refine((values) => new Set(values).size === values.length, {
      error: "Binding scope values must not repeat.",
    }))
    .register(z.globalRegistry, { uniqueItems: true });

const bindingTargetFields = {
  provider: z.strictObject({ kind: z.literal("provider"), providerId: ProviderId }),
  runtime: z.strictObject({ kind: z.literal("runtime"), runtimeId: RuntimeId }),
  model: z.strictObject({ kind: z.literal("model"), modelId: ModelId }),
  runtimeModel: z.strictObject({
    kind: z.literal("runtime-model"),
    runtimeId: RuntimeId,
    modelId: ModelId,
  }),
};

export const BindingTargetDto = z.discriminatedUnion("kind", [
  bindingTargetFields.provider,
  bindingTargetFields.runtime,
  bindingTargetFields.model,
  bindingTargetFields.runtimeModel,
]);
export type BindingTargetDto = z.infer<typeof BindingTargetDto>;
export type BindingTargetDtoInput = z.input<typeof BindingTargetDto>;

export const BindingScopeDto = z.strictObject({
  projectId: z.optional(uniqueNonEmpty(ProjectMarkerId)),
  workflowId: z.optional(uniqueNonEmpty(WorkflowId)),
  stageId: z.optional(uniqueNonEmpty(StageId)),
  taskTypeId: z.optional(uniqueNonEmpty(TaskTypeId)),
  roleId: z.optional(uniqueNonEmpty(RoleId)),
  providerId: z.optional(uniqueNonEmpty(ProviderId)),
  runtimeId: z.optional(uniqueNonEmpty(RuntimeId)),
  modelId: z.optional(uniqueNonEmpty(ModelId)),
  directory: z.optional(uniqueNonEmpty(DirectoryPath)),
});
export type BindingScopeDto = z.infer<typeof BindingScopeDto>;
export type BindingScopeDtoInput = z.input<typeof BindingScopeDto>;

export const BindingDefinitionDto = z.strictObject({
  bindingId: BindingId,
  target: BindingTargetDto,
  scope: z.optional(BindingScopeDto),
  fallbackFor: z.optional(BindingId),
  description: z.string(),
});
export type BindingDefinitionDto = z.infer<typeof BindingDefinitionDto>;
export type BindingDefinitionDtoInput = z.input<typeof BindingDefinitionDto>;

export const BINDING_SOURCE_LAYERS = ["global", "personal", "project"] as const;
const bindingSourceArms = [
  z.strictObject({ layer: z.literal("global") }),
  z.strictObject({ layer: z.literal("personal") }),
  z.strictObject({ layer: z.literal("project"), projectId: ProjectMarkerId }),
] as const;
const BindingSourceDto = z.discriminatedUnion("layer", bindingSourceArms);
export { BindingSourceDto };
export type BindingSourceDto = z.infer<typeof BindingSourceDto>;
export type BindingSourceDtoInput = z.input<typeof BindingSourceDto>;

const bindingRecordBase = {
  revision: AssetRevision,
  loadingTier: LoadingTier,
};
export const BindingRecordDto = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("add"), definition: BindingDefinitionDto, source: BindingSourceDto, ...bindingRecordBase }),
  z.strictObject({ operation: z.literal("override"), definition: BindingDefinitionDto, source: bindingSourceArms[2], ...bindingRecordBase }),
  z.strictObject({
    operation: z.literal("disable"),
    bindingId: BindingId,
    scope: z.optional(BindingScopeDto),
    source: bindingSourceArms[2],
    ...bindingRecordBase,
  }),
]);
export type BindingRecordDto = z.infer<typeof BindingRecordDto>;
export type BindingRecordDtoInput = z.input<typeof BindingRecordDto>;

export const BindingTargetIssueDto = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("target_missing"), targetId: NonEmptyString }),
  z.strictObject({
    kind: z.literal("target_provider_mismatch"),
    targetId: NonEmptyString,
    providerId: ProviderId,
  }),
]);
export type BindingTargetIssueDto = z.infer<typeof BindingTargetIssueDto>;
export type BindingTargetIssueDtoInput = z.input<typeof BindingTargetIssueDto>;

export const BindingTargetAvailabilityDto = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("available") }),
  z.strictObject({
    status: z.literal("unavailable"),
    issues: z.array(BindingTargetIssueDto).check(z.minLength(1)),
  }),
]);
export type BindingTargetAvailabilityDto = z.infer<typeof BindingTargetAvailabilityDto>;
export type BindingTargetAvailabilityDtoInput = z.input<typeof BindingTargetAvailabilityDto>;

export const BindingFallbackRelationDto = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({ kind: z.literal("linked"), primaryBindingId: BindingId }),
  z.strictObject({ kind: z.literal("missing"), primaryBindingId: BindingId }),
  z.strictObject({
    kind: z.literal("cycle"),
    primaryBindingId: BindingId,
    cycle: z.array(BindingId).check(z.minLength(2)),
  }),
]);
export type BindingFallbackRelationDto = z.infer<typeof BindingFallbackRelationDto>;
export type BindingFallbackRelationDtoInput = z.input<typeof BindingFallbackRelationDto>;

const bindingCandidateBase = {
  revision: AssetRevision,
  loadingTier: LoadingTier,
  applicability: ResolutionReason,
};
export const BindingCandidateDto = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("add"),
    definition: BindingDefinitionDto,
    targetAvailability: BindingTargetAvailabilityDto,
    fallbackRelation: BindingFallbackRelationDto,
    source: BindingSourceDto,
    ...bindingCandidateBase,
  }),
  z.strictObject({
    operation: z.literal("override"),
    definition: BindingDefinitionDto,
    targetAvailability: BindingTargetAvailabilityDto,
    fallbackRelation: BindingFallbackRelationDto,
    source: bindingSourceArms[2],
    ...bindingCandidateBase,
  }),
  z.strictObject({
    operation: z.literal("disable"),
    bindingId: BindingId,
    scope: z.optional(BindingScopeDto),
    source: bindingSourceArms[2],
    ...bindingCandidateBase,
  }),
]);
export type BindingCandidateDto = z.infer<typeof BindingCandidateDto>;
export type BindingCandidateDtoInput = z.input<typeof BindingCandidateDto>;

export const BindingResolutionRequest = z.strictObject({
  context: ResolutionContextInput,
  ide: z.optional(IdeContextInput),
  loadingTiers: z.optional(z.array(LoadingTier).check(z.minLength(1))),
});
export type BindingResolutionRequest = z.infer<typeof BindingResolutionRequest>;
export type BindingResolutionRequestInput = z.input<typeof BindingResolutionRequest>;

export const SelectedStageRequirementsDto = z.strictObject({
  workflowId: WorkflowId,
  stageId: StageId,
  requiredRoleId: z.optional(RoleId),
  requiredTaskTypeId: z.optional(TaskTypeId),
});
export type SelectedStageRequirementsDto = z.infer<typeof SelectedStageRequirementsDto>;
export type SelectedStageRequirementsDtoInput = z.input<typeof SelectedStageRequirementsDto>;

export const SelectedStageRequirementsRequest = z.strictObject({
  context: ResolutionContextInput,
  ide: z.optional(IdeContextInput),
});
export type SelectedStageRequirementsRequest = z.infer<typeof SelectedStageRequirementsRequest>;
export type SelectedStageRequirementsRequestInput = z.input<typeof SelectedStageRequirementsRequest>;

export const SelectedStageRequirementsResponse = z.strictObject({
  context: ResolutionContextInput,
  requirements: z.optional(SelectedStageRequirementsDto),
  diagnostics: z.optional(z.array(CoreErrorDetail).check(z.minLength(1))),
});
export type SelectedStageRequirementsResponse = z.infer<typeof SelectedStageRequirementsResponse>;
export type SelectedStageRequirementsResponseInput = z.input<typeof SelectedStageRequirementsResponse>;

export const BindingResolutionResponse = z.strictObject({
  context: ResolutionContextInput,
  candidates: z.array(BindingCandidateDto),
  diagnostics: z.optional(z.array(CoreErrorDetail).check(z.minLength(1))),
});
export type BindingResolutionResponse = z.infer<typeof BindingResolutionResponse>;
export type BindingResolutionResponseInput = z.input<typeof BindingResolutionResponse>;

export const parseBindingTargetDto = (value: unknown): BindingTargetDto => z.parse(BindingTargetDto, value);
export const tryParseBindingTargetDto = (value: unknown): ParseOutcome<BindingTargetDto> => tryParseWith(BindingTargetDto, value, "response");
export const parseBindingScopeDto = (value: unknown): BindingScopeDto => z.parse(BindingScopeDto, value);
export const tryParseBindingScopeDto = (value: unknown): ParseOutcome<BindingScopeDto> => tryParseWith(BindingScopeDto, value, "response");
export const parseBindingDefinitionDto = (value: unknown): BindingDefinitionDto => z.parse(BindingDefinitionDto, value);
export const tryParseBindingDefinitionDto = (value: unknown): ParseOutcome<BindingDefinitionDto> => tryParseWith(BindingDefinitionDto, value, "response");
export const parseBindingSourceDto = (value: unknown): BindingSourceDto => z.parse(BindingSourceDto, value);
export const tryParseBindingSourceDto = (value: unknown): ParseOutcome<BindingSourceDto> => tryParseWith(BindingSourceDto, value, "response");
export const parseBindingRecordDto = (value: unknown): BindingRecordDto => z.parse(BindingRecordDto, value);
export const tryParseBindingRecordDto = (value: unknown): ParseOutcome<BindingRecordDto> => tryParseWith(BindingRecordDto, value, "response");
export const parseBindingTargetIssueDto = (value: unknown): BindingTargetIssueDto => z.parse(BindingTargetIssueDto, value);
export const tryParseBindingTargetIssueDto = (value: unknown): ParseOutcome<BindingTargetIssueDto> => tryParseWith(BindingTargetIssueDto, value, "response");
export const parseBindingTargetAvailabilityDto = (value: unknown): BindingTargetAvailabilityDto => z.parse(BindingTargetAvailabilityDto, value);
export const tryParseBindingTargetAvailabilityDto = (value: unknown): ParseOutcome<BindingTargetAvailabilityDto> => tryParseWith(BindingTargetAvailabilityDto, value, "response");
export const parseBindingFallbackRelationDto = (value: unknown): BindingFallbackRelationDto => z.parse(BindingFallbackRelationDto, value);
export const tryParseBindingFallbackRelationDto = (value: unknown): ParseOutcome<BindingFallbackRelationDto> => tryParseWith(BindingFallbackRelationDto, value, "response");
export const parseBindingCandidateDto = (value: unknown): BindingCandidateDto => z.parse(BindingCandidateDto, value);
export const tryParseBindingCandidateDto = (value: unknown): ParseOutcome<BindingCandidateDto> => tryParseWith(BindingCandidateDto, value, "response");
export const parseBindingResolutionRequest = (value: unknown): BindingResolutionRequest => z.parse(BindingResolutionRequest, value);
export const tryParseBindingResolutionRequest = (value: unknown): ParseOutcome<BindingResolutionRequest> => tryParseWith(BindingResolutionRequest, value, "request");
export const parseSelectedStageRequirementsDto = (value: unknown): SelectedStageRequirementsDto => z.parse(SelectedStageRequirementsDto, value);
export const tryParseSelectedStageRequirementsDto = (value: unknown): ParseOutcome<SelectedStageRequirementsDto> => tryParseWith(SelectedStageRequirementsDto, value, "response");
export const parseSelectedStageRequirementsRequest = (value: unknown): SelectedStageRequirementsRequest => z.parse(SelectedStageRequirementsRequest, value);
export const tryParseSelectedStageRequirementsRequest = (value: unknown): ParseOutcome<SelectedStageRequirementsRequest> => tryParseWith(SelectedStageRequirementsRequest, value, "request");
export const parseSelectedStageRequirementsResponse = (value: unknown): SelectedStageRequirementsResponse => z.parse(SelectedStageRequirementsResponse, value);
export const tryParseSelectedStageRequirementsResponse = (value: unknown): ParseOutcome<SelectedStageRequirementsResponse> => tryParseWith(SelectedStageRequirementsResponse, value, "response");
export const parseBindingResolutionResponse = (value: unknown): BindingResolutionResponse => z.parse(BindingResolutionResponse, value);
export const tryParseBindingResolutionResponse = (value: unknown): ParseOutcome<BindingResolutionResponse> => tryParseWith(BindingResolutionResponse, value, "response");
