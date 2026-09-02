import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { tryParseProjectMarkerDto } from "@aacl/shared";
import type { ProjectId } from "@aacl/shared";
import { readRegularUtf8 } from "../internal/regular-file.ts";

export type MarkerObservation =
  | { readonly status: "missing" }
  | { readonly status: "valid"; readonly projectId: ProjectId }
  | { readonly status: "invalid" }
  | { readonly status: "unavailable" };

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
};

export const observeMarker = async (projectRoot: string): Promise<MarkerObservation> => {
  const projectDirectory = join(projectRoot, ".aacl");
  const markerPath = join(projectDirectory, "project.json");
  try {
    const directoryInfo = await lstat(projectDirectory);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) return { status: "invalid" };
  } catch (error) {
    return errorCode(error) === "ENOENT" ? { status: "missing" } : { status: "unavailable" };
  }

  const read = await readRegularUtf8(markerPath);
  if (read.status === "missing") return { status: "missing" };
  if (read.status === "not_regular") return { status: "invalid" };
  if (read.status === "unavailable") return { status: "unavailable" };
  try {
    const parsed = tryParseProjectMarkerDto(JSON.parse(read.contents) as unknown);
    return parsed.ok ? { status: "valid", projectId: parsed.value.projectId } : { status: "invalid" };
  } catch {
    return { status: "invalid" };
  }
};
