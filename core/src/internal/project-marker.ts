import { lstat } from "node:fs/promises";
import type { Stats } from "node:fs";
import {
  assertDirectoryIdentity,
  assertRegularFileIdentity,
  fileIdentityOf,
  sameFileIdentity,
  type FileIdentity,
} from "./fs-identity.ts";
import { readRegularUtf8 } from "./regular-file.ts";

export type MarkerSourceSnapshot = {
  readonly directoryIdentity: FileIdentity;
  readonly markerIdentity: FileIdentity;
};

export type MarkerSource = MarkerSourceSnapshot & {
  readonly assertSource: () => void;
};

export type MarkerDirectoryRead =
  | { readonly status: "missing_directory" }
  | { readonly status: "invalid_directory" }
  | { readonly status: "unavailable_directory"; readonly error: unknown }
  | { readonly status: "missing_marker" }
  | { readonly status: "invalid_marker" }
  | { readonly status: "unavailable_marker"; readonly error: unknown }
  | { readonly status: "ok"; readonly contents: string; readonly mode: number; readonly source: MarkerSource };

export type MarkerDirectoryReadOptions = {
  readonly beforeDirectoryFreshStat?: () => void | Promise<void>;
  readonly afterDirectoryFreshStat?: () => void | Promise<void>;
};

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
};

const sourceFor = (
  projectDirectory: string,
  markerPath: string,
  directoryIdentity: FileIdentity,
  markerIdentity: FileIdentity,
): MarkerSource => ({
  directoryIdentity,
  markerIdentity,
  assertSource: () => {
    assertDirectoryIdentity(projectDirectory, directoryIdentity);
    assertRegularFileIdentity(markerPath, markerIdentity);
  },
});

export const markerSourceFromSnapshot = (
  projectDirectory: string,
  markerPath: string,
  snapshot: MarkerSourceSnapshot,
): MarkerSource => sourceFor(
  projectDirectory,
  markerPath,
  snapshot.directoryIdentity,
  snapshot.markerIdentity,
);

/**
 * Read a Project Marker while retaining the identity of its containing directory.
 * The final directory check makes a path replacement during the Marker read fail closed.
 */
export const readMarkerInDirectory = async (
  projectDirectory: string,
  markerPath: string,
  options: MarkerDirectoryReadOptions = {},
): Promise<MarkerDirectoryRead> => {
  let directoryInfo: Stats;
  try {
    directoryInfo = await lstat(projectDirectory);
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { status: "missing_directory" }
      : { status: "unavailable_directory", error };
  }

  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
    return { status: "invalid_directory" };
  }
  const directoryIdentity = fileIdentityOf(directoryInfo);

  const marker = await readRegularUtf8(markerPath);
  let result:
    | Exclude<MarkerDirectoryRead, { readonly status: "ok" }>
    | { readonly status: "ok"; readonly contents: string; readonly mode: number; readonly markerIdentity: FileIdentity };
  if (marker.status === "missing") {
    result = { status: "missing_marker" };
  } else if (marker.status === "not_regular") {
    result = { status: "invalid_marker" };
  } else if (marker.status === "unavailable") {
    result = { status: "unavailable_marker", error: marker.error };
  } else {
    result = { status: "ok", contents: marker.contents, mode: marker.mode, markerIdentity: marker.identity };
  }

  try {
    await options.beforeDirectoryFreshStat?.();
  } catch (error) {
    return { status: "unavailable_directory", error };
  }

  let freshDirectoryInfo: Stats;
  try {
    freshDirectoryInfo = await lstat(projectDirectory);
  } catch (error) {
    return { status: "unavailable_directory", error };
  }
  if (
    freshDirectoryInfo.isSymbolicLink()
    || !freshDirectoryInfo.isDirectory()
    || !sameFileIdentity(directoryIdentity, fileIdentityOf(freshDirectoryInfo))
  ) {
    return { status: "invalid_directory" };
  }
  try {
    await options.afterDirectoryFreshStat?.();
  } catch (error) {
    return { status: "unavailable_directory", error };
  }
  return result.status === "ok"
    ? {
        status: "ok",
        contents: result.contents,
        mode: result.mode,
        source: sourceFor(projectDirectory, markerPath, directoryIdentity, result.markerIdentity),
      }
    : result;
};
