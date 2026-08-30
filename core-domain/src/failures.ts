import type { CoreErrorCode, CoreErrorDetail, CoreErrorDto } from "@aacl/shared";

export type CoreFailure = {
  readonly code: CoreErrorCode;
  readonly message: string;
  readonly details?: readonly CoreErrorDetail[];
};

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
  return failure.details === undefined || failure.details.length === 0
    ? base
    : { ...base, details: [...failure.details] };
};
