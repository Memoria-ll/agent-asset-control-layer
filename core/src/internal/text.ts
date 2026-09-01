import { coreFailure, type AssetResult } from "@aacl/core-domain";

/** Decode bytes as fatal UTF-8 for asset and catalog file readers. */
export const strictDecode = (
  bytes: Buffer,
  failurePath: readonly string[] = ["document"],
  subject = "asset",
): AssetResult<string> => {
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { ok: true, value };
  } catch {
    const message = `The ${subject} file is not valid UTF-8.`;
    return {
      ok: false,
      failure: coreFailure("invalid_request", message, [
        { path: [...failurePath], code: "invalid_utf8", message },
      ]),
    };
  }
};
