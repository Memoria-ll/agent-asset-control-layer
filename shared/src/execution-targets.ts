import * as z from "zod/mini";
import { ProviderId, RuntimeId, ModelId } from "./identifiers.js";
import { NonEmptyString } from "./primitives.js";
import { tryParseWith, type ParseOutcome } from "./errors.js";

/**
 * Metadata for the execution targets a request can be resolved against.
 *
 * These DTOs stay static: availability is carried by the resolution result
 * (`ResolutionReason`), not by the catalogue entry, because availability is a
 * runtime property of one resolution while the catalogue is not.
 *
 * Capability, tier, context window and cost are absent on purpose — those drive
 * routing policy (#8), and a field for them here would open that decision inside
 * the contract package.
 */

export const ProviderDto = z.strictObject({
  providerId: ProviderId,
  displayName: NonEmptyString,
});
export type ProviderDto = z.infer<typeof ProviderDto>;
export type ProviderDtoInput = z.input<typeof ProviderDto>;

export const RuntimeDto = z.strictObject({
  runtimeId: RuntimeId,
  displayName: NonEmptyString,
  providerId: ProviderId,
});
export type RuntimeDto = z.infer<typeof RuntimeDto>;
export type RuntimeDtoInput = z.input<typeof RuntimeDto>;

export const ModelDto = z.strictObject({
  modelId: ModelId,
  displayName: NonEmptyString,
  providerId: ProviderId,
});
export type ModelDto = z.infer<typeof ModelDto>;
export type ModelDtoInput = z.input<typeof ModelDto>;

export const parseProviderDto = (value: unknown): ProviderDto =>
  z.parse(ProviderDto, value);

export const tryParseProviderDto = (value: unknown): ParseOutcome<ProviderDto> =>
  tryParseWith(ProviderDto, value);

export const parseRuntimeDto = (value: unknown): RuntimeDto =>
  z.parse(RuntimeDto, value);

export const tryParseRuntimeDto = (value: unknown): ParseOutcome<RuntimeDto> =>
  tryParseWith(RuntimeDto, value);

export const parseModelDto = (value: unknown): ModelDto => z.parse(ModelDto, value);

export const tryParseModelDto = (value: unknown): ParseOutcome<ModelDto> =>
  tryParseWith(ModelDto, value);
