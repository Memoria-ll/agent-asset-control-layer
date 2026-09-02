import { lstat, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

export type RegularFileRead =
  | { readonly status: "missing" }
  | { readonly status: "not_regular" }
  | { readonly status: "unavailable"; readonly error: unknown }
  | { readonly status: "ok"; readonly contents: string; readonly mode: number };

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
};

/** Inspect the path before reading so FIFOs and other special files never block a caller. */
export const readRegularUtf8 = async (filePath: string): Promise<RegularFileRead> => {
  let linkInfo;
  try {
    linkInfo = await lstat(filePath);
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { status: "missing" }
      : { status: "unavailable", error };
  }

  if (linkInfo.isSymbolicLink() || !linkInfo.isFile()) return { status: "not_regular" };

  let handle: FileHandle | undefined;
  try {
    handle = await open(filePath, "r");
    const fileInfo = await handle.stat();
    if (!fileInfo.isFile()) return { status: "not_regular" };
    if (linkInfo.dev !== fileInfo.dev || linkInfo.ino !== fileInfo.ino) {
      return { status: "not_regular" };
    }
    return {
      status: "ok",
      contents: await handle.readFile("utf8"),
      mode: fileInfo.mode,
    };
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { status: "missing" }
      : { status: "unavailable", error };
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // The read result is already determined; a close failure cannot change it.
      }
    }
  }
};
