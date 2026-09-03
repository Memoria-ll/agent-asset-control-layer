import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

export type RegularFileRead =
  | { readonly status: "missing" }
  | { readonly status: "not_regular" }
  | { readonly status: "unavailable"; readonly error: unknown }
  | { readonly status: "ok"; readonly contents: string; readonly mode: number };

export type RegularFileReadOptions = {
  readonly beforeOpen?: () => void | Promise<void>;
  readonly beforeFreshStat?: () => void | Promise<void>;
};

const readFlags = process.platform === "win32"
  ? constants.O_RDONLY
  : constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
};

/** Inspect the path before reading so FIFOs and other special files never block a caller. */
export const readRegularUtf8 = async (
  filePath: string,
  options: RegularFileReadOptions = {},
): Promise<RegularFileRead> => {
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
    await options.beforeOpen?.();
    handle = await open(filePath, readFlags);
    const fileInfo = await handle.stat();
    if (!fileInfo.isFile()) return { status: "not_regular" };
    if (linkInfo.dev !== fileInfo.dev || linkInfo.ino !== fileInfo.ino) return { status: "not_regular" };
    const contents = await handle.readFile("utf8");
    await options.beforeFreshStat?.();
    const freshPathInfo = await lstat(filePath);
    if (freshPathInfo.isSymbolicLink() || !freshPathInfo.isFile()) return { status: "not_regular" };
    if (freshPathInfo.dev !== fileInfo.dev || freshPathInfo.ino !== fileInfo.ino) return { status: "not_regular" };
    return {
      status: "ok",
      contents,
      mode: fileInfo.mode,
    };
  } catch (error) {
    if (errorCode(error) === "ELOOP") return { status: "not_regular" };
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
