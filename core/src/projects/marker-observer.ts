import { join } from "node:path";
import { tryParseProjectMarkerDto } from "@aacl/shared";
import type { ProjectId } from "@aacl/shared";
import {
  readMarkerInDirectory,
  type MarkerSourceSnapshot,
  type MarkerDirectoryReadOptions,
} from "../internal/project-marker.ts";

export type MarkerObservation =
  | { readonly status: "missing" }
  | { readonly status: "valid"; readonly projectId: ProjectId; readonly source: MarkerSourceSnapshot }
  | { readonly status: "invalid" }
  | { readonly status: "unavailable" };

export const observeMarker = async (
  projectRoot: string,
  options: MarkerDirectoryReadOptions = {},
): Promise<MarkerObservation> => {
  const projectDirectory = join(projectRoot, ".aacl");
  const markerPath = join(projectDirectory, "project.json");
  const read = await readMarkerInDirectory(projectDirectory, markerPath, options);
  if (read.status === "missing_directory" || read.status === "missing_marker") return { status: "missing" };
  if (read.status === "invalid_directory" || read.status === "invalid_marker") return { status: "invalid" };
  if (read.status === "unavailable_directory" || read.status === "unavailable_marker") return { status: "unavailable" };
  try {
    const parsed = tryParseProjectMarkerDto(JSON.parse(read.contents) as unknown);
    return parsed.ok
      ? {
          status: "valid",
          projectId: parsed.value.projectId,
          source: {
            directoryIdentity: read.source.directoryIdentity,
            markerIdentity: read.source.markerIdentity,
          },
        }
      : { status: "invalid" };
  } catch {
    return { status: "invalid" };
  }
};
