import type { CoreErrorCode, CoreErrorDetail, CoreErrorDto } from "@aacl/shared";

export type CoreFailure = {
  readonly code: CoreErrorCode;
  readonly message: string;
  readonly details?: readonly CoreErrorDetail[];
};

export type AssetResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: CoreFailure };

export const coreFailure = (
  code: CoreErrorCode,
  message: string,
  details?: readonly CoreErrorDetail[],
): CoreFailure => {
  // Empty messages produce invalid CoreErrorDto values because the contract requires NonEmptyString.
  if (message.trim() === "") {
    throw new Error("Core failure message must not be empty.");
  }

  return details === undefined ? { code, message } : { code, message, details };
};

export const toCoreErrorDto = (failure: CoreFailure): CoreErrorDto => {
  const base = { code: failure.code, message: failure.message };
  // An empty list is dropped rather than serialized: CoreErrorDto.details carries minLength(1),
  // so `details: []` fails parseCoreErrorDto while an absent key is valid.
  return failure.details === undefined || failure.details.length === 0
    ? base
    : { ...base, details: [...failure.details] };
};
