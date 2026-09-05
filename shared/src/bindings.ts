import * as z from "zod/mini";
import {
  AssetId,
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
import { ProjectMarkerId } from "./projects.ts";
import { IdeContextInput } from "./resolution.ts";
import { LoadingTier, ResolutionContextInput } from "./resolved-context.ts";
import { DirectoryPath, NonEmptyString } from "./primitives.ts";
import { CapabilityDegradationDto } from "./status.ts";

export const BINDING_TARGET_KINDS = [
  "provider",
  "runtime",
  "model",
  "runtime-model",
] as const;
export const BindingTargetKind = z.enum(BINDING_TARGET_KINDS);
export type BindingTargetKind = z.infer<typeof BindingTargetKind>;

export const BINDING_CANDIDATE_STATUSES = ["eligible", "unavailable", "fallback"] as const;
export const BindingCandidateStatus = z.enum(BINDING_CANDIDATE_STATUSES);
export type BindingCandidateStatus = z.infer<typeof BindingCandidateStatus>;

export const BINDING_REASON_KINDS = [
  "eligible",
  "scope_mismatch",
  "binding_disabled",
  "binding_overridden",
  "target_missing",
  "target_provider_mismatch",
  "capability_unavailable",
  "capability_not_allowed",
  "requirement_unavailable",
  "fallback_not_needed",
  "fallback_primary_unavailable",
  "invalid_binding",
] as const;
export const BindingReasonKind = z.enum(BINDING_REASON_KINDS);
export type BindingReasonKind = z.infer<typeof BindingReasonKind>;

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

const BindingFallbackDefinitionDto = z.strictObject({
  bindingId: BindingId,
  target: BindingTargetDto,
  scope: z.optional(BindingScopeDto),
  fallbackFor: BindingId,
  description: z.string(),
});

const BindingEligibleDefinitionDto = z.strictObject({
  bindingId: BindingId,
  target: BindingTargetDto,
  scope: z.optional(BindingScopeDto),
  description: z.string(),
});

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
  source: BindingSourceDto,
  loadingTier: LoadingTier,
};
/**
 * Only a Project layer may carry an operation other than `add`: candidate
 * projection rejects every other combination outright, so an overlay record
 * naming a Global or Personal source is one Core can never resolve.
 */
const bindingOverlayRecordBase = { ...bindingRecordBase, source: bindingSourceArms[2] };
export const BindingRecordDto = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("add"), definition: BindingDefinitionDto, ...bindingRecordBase }),
  z.strictObject({ operation: z.literal("override"), definition: BindingDefinitionDto, ...bindingOverlayRecordBase }),
  z.strictObject({
    operation: z.literal("disable"),
    bindingId: BindingId,
    scope: z.optional(BindingScopeDto),
    ...bindingOverlayRecordBase,
  }),
]);
export type BindingRecordDto = z.infer<typeof BindingRecordDto>;
export type BindingRecordDtoInput = z.input<typeof BindingRecordDto>;

const eligibleBindingReason = z.strictObject({
  kind: z.literal("eligible"),
  degradedCapabilities: z.optional(z.array(CapabilityDegradationDto).check(z.minLength(1))),
});
/**
 * One definition for both schemas that publish this reason: a fallback candidate
 * carries it with the degradation its own capabilities took, so a copy without
 * `degradedCapabilities` makes `parseBindingReasonDto` reject a reason lifted
 * out of a valid response.
 */
const fallbackPrimaryUnavailableReason = z.strictObject({
  kind: z.literal("fallback_primary_unavailable"),
  primaryBindingId: BindingId,
  degradedCapabilities: z.optional(z.array(CapabilityDegradationDto).check(z.minLength(1))),
});
const unavailableBindingReasonArms = [
  z.strictObject({ kind: z.literal("scope_mismatch"), axis: BindingScopeAxis }),
  z.strictObject({ kind: z.literal("binding_disabled"), actorBindingId: BindingId }),
  z.strictObject({ kind: z.literal("binding_overridden"), actorBindingId: BindingId }),
  z.strictObject({ kind: z.literal("target_missing"), targetId: NonEmptyString }),
  z.strictObject({
    kind: z.literal("target_provider_mismatch"),
    targetId: NonEmptyString,
    providerId: ProviderId,
  }),
  z.strictObject({ kind: z.literal("capability_unavailable"), capabilityId: NonEmptyString }),
  z.strictObject({ kind: z.literal("capability_not_allowed"), capabilityId: NonEmptyString }),
  // One per unsatisfied `requires` entry, mirroring the capability arms. Why the
  // requirement failed is a property of the whole resolution rather than of this
  // Binding, so it travels in the response diagnostics instead.
  z.strictObject({ kind: z.literal("requirement_unavailable"), requirementId: AssetId }),
  z.strictObject({ kind: z.literal("fallback_not_needed"), primaryBindingId: BindingId }),
  z.strictObject({ kind: z.literal("invalid_binding"), bindingId: BindingId }),
] as const;
// `fallback_primary_unavailable` is why a Binding *is* the standing fallback, so
// it belongs to a `fallback` candidate alone. Admitting it here would let a
// candidate be unavailable and activated at once.
const unavailableBindingReasons = z.discriminatedUnion("kind", unavailableBindingReasonArms);
export const BindingReasonDto = z.discriminatedUnion("kind", [
  eligibleBindingReason,
  fallbackPrimaryUnavailableReason,
  ...unavailableBindingReasonArms,
]);
export type BindingReasonDto = z.infer<typeof BindingReasonDto>;
export type BindingReasonDtoInput = z.input<typeof BindingReasonDto>;

const fallbackBindingReasons = z.discriminatedUnion("kind", [fallbackPrimaryUnavailableReason]);
const bindingCandidateBase = {
  revision: AssetRevision,
  source: BindingSourceDto,
  loadingTier: LoadingTier,
};
export const BindingCandidateDto = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("eligible"),
    definition: BindingEligibleDefinitionDto,
    // Exactly one: an eligible candidate has a single reason, with every
    // capability degradation nested inside it rather than split across entries.
    reasons: z.array(eligibleBindingReason).check(z.minLength(1)).check(z.maxLength(1)),
    ...bindingCandidateBase,
  }),
  z.strictObject({
    status: z.literal("fallback"),
    definition: BindingFallbackDefinitionDto,
    reasons: z.array(fallbackBindingReasons).check(z.minLength(1)),
    ...bindingCandidateBase,
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    bindingId: BindingId,
    definition: z.optional(BindingDefinitionDto),
    reasons: z.array(unavailableBindingReasons).check(z.minLength(1)),
    ...bindingCandidateBase,
  }),
]).check(z.refine((candidate) => {
  if (candidate.status === "eligible") return true;
  if (candidate.status === "fallback") {
    return candidate.reasons.every(({ primaryBindingId }) => primaryBindingId === candidate.definition.fallbackFor);
  }
  if (candidate.definition !== undefined && candidate.definition.bindingId !== candidate.bindingId) return false;
  return candidate.reasons.every((reason) => {
    // The only reason arm naming the Binding it is about rather than another
    // one: `binding_disabled` and `binding_overridden` name the actor, which a
    // same-ID overlay makes equal to this candidate and a cross-ID one does not.
    if (reason.kind === "invalid_binding") return reason.bindingId === candidate.bindingId;
    if (reason.kind !== "fallback_not_needed") return true;
    return candidate.definition?.fallbackFor === reason.primaryBindingId;
  });
}, { error: "Binding candidate identifiers and fallback relations must be consistent." }));
export type BindingCandidateDto = z.infer<typeof BindingCandidateDto>;
export type BindingCandidateDtoInput = z.input<typeof BindingCandidateDto>;

/**
 * Each `BINDING_*` array is the closed set consumers enumerate; the union arms
 * publishing those values are internal and invisible to them. These pin every
 * pair together, so an arm carrying a value its array omits — or an array member
 * no arm publishes — fails to compile instead of shipping a set whose two public
 * representations disagree.
 */
type SameMembers<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : never) : never;
const bindingClosedSetsMatchArms: readonly true[] = [
  true satisfies SameMembers<BindingReasonDto["kind"], BindingReasonKind>,
  true satisfies SameMembers<BindingTargetDto["kind"], BindingTargetKind>,
  true satisfies SameMembers<BindingCandidateDto["status"], BindingCandidateStatus>,
  true satisfies SameMembers<BindingSourceDto["layer"], typeof BINDING_SOURCE_LAYERS[number]>,
];
void bindingClosedSetsMatchArms;

export const BindingResolutionRequest = z.strictObject({
  context: ResolutionContextInput,
  ide: z.optional(IdeContextInput),
  loadingTiers: z.optional(z.array(LoadingTier).check(z.minLength(1))),
});
export type BindingResolutionRequest = z.infer<typeof BindingResolutionRequest>;
export type BindingResolutionRequestInput = z.input<typeof BindingResolutionRequest>;

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
export const parseBindingReasonDto = (value: unknown): BindingReasonDto => z.parse(BindingReasonDto, value);
export const tryParseBindingReasonDto = (value: unknown): ParseOutcome<BindingReasonDto> => tryParseWith(BindingReasonDto, value, "response");
export const parseBindingCandidateDto = (value: unknown): BindingCandidateDto => z.parse(BindingCandidateDto, value);
export const tryParseBindingCandidateDto = (value: unknown): ParseOutcome<BindingCandidateDto> => tryParseWith(BindingCandidateDto, value, "response");
export const parseBindingResolutionRequest = (value: unknown): BindingResolutionRequest => z.parse(BindingResolutionRequest, value);
export const tryParseBindingResolutionRequest = (value: unknown): ParseOutcome<BindingResolutionRequest> => tryParseWith(BindingResolutionRequest, value, "request");
export const parseBindingResolutionResponse = (value: unknown): BindingResolutionResponse => z.parse(BindingResolutionResponse, value);
export const tryParseBindingResolutionResponse = (value: unknown): ParseOutcome<BindingResolutionResponse> => tryParseWith(BindingResolutionResponse, value, "response");
