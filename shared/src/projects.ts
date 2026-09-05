import * as z from "zod/mini";
import { CoreErrorDetail, tryParseWith, type ParseOutcome } from "./errors.ts";
import { ProjectId } from "./identifiers.ts";
import { DirectoryPath, NonEmptyString } from "./primitives.ts";

export const PROJECT_MARKER_SCHEMA_VERSION = 1;
export const PROJECT_MARKER_ID_MAX_LENGTH = 128;

const PROJECT_MARKER_ID_PATTERN = /^project-[a-z0-9-]+$/;

/**
 * A Project identity as the Marker defines it. Every Project id Core can ever
 * observe comes from a Marker, so a DTO field naming a Project carries this
 * rather than the bare branded id.
 */
export const ProjectMarkerId = ProjectId
  .check(z.regex(PROJECT_MARKER_ID_PATTERN))
  .check(z.maxLength(PROJECT_MARKER_ID_MAX_LENGTH));

/**
 * The same constraint as plain JavaScript, for consumers outside this package:
 * the schema is an implementation detail they must not import.
 */
export const isProjectMarkerId = (value: string): boolean =>
  PROJECT_MARKER_ID_PATTERN.test(value) && value.length <= PROJECT_MARKER_ID_MAX_LENGTH;

/** The durable identity stored at `<project-root>/.aacl/project.json`. */
export const ProjectMarkerDto = z.strictObject({
  schemaVersion: z.literal(PROJECT_MARKER_SCHEMA_VERSION),
  projectId: ProjectMarkerId,
});
export type ProjectMarkerDto = z.infer<typeof ProjectMarkerDto>;
export type ProjectMarkerDtoInput = z.input<typeof ProjectMarkerDto>;

/** Core supplies the identity; this factory owns the on-disk schema version. */
export const createProjectMarkerDto = (projectId: string): ProjectMarkerDto =>
  z.parse(ProjectMarkerDto, {
    schemaVersion: PROJECT_MARKER_SCHEMA_VERSION,
    projectId,
  });

/** Explicit root selection keeps Project identity independent from Git discovery. */
export const ProjectInitRequest = z.strictObject({
  projectRoot: DirectoryPath,
});
export type ProjectInitRequest = z.infer<typeof ProjectInitRequest>;
export type ProjectInitRequestInput = z.input<typeof ProjectInitRequest>;

export const ProjectInfoDto = z.strictObject({
  projectId: ProjectMarkerId,
  projectRoot: DirectoryPath,
});
export type ProjectInfoDto = z.infer<typeof ProjectInfoDto>;
export type ProjectInfoDtoInput = z.input<typeof ProjectInfoDto>;

export const ProjectDiscoveryRequest = z.strictObject({
  workspacePath: DirectoryPath,
});
export type ProjectDiscoveryRequest = z.infer<typeof ProjectDiscoveryRequest>;
export type ProjectDiscoveryRequestInput = z.input<typeof ProjectDiscoveryRequest>;

export const PROJECT_DISCOVERY_STATUSES = [
  "initialized",
  "uninitialized",
  "invalid",
  "mismatch",
] as const;
export type ProjectDiscoveryStatus = typeof PROJECT_DISCOVERY_STATUSES[number];

const discoveryBase = {
  workspacePath: DirectoryPath,
};

const ProjectDiscoveryFailureDto = z.strictObject({
  code: z.enum(["invalid_request", "unavailable"]),
  message: NonEmptyString,
  details: z.optional(z.array(CoreErrorDetail).check(z.minLength(1))),
});

/**
 * Discovery stops at the nearest `.aacl` directory. A malformed nearest marker is
 * reported instead of falling through to a parent Project.
 */
export const ProjectDiscoveryDto = z.discriminatedUnion("status", [
  z.strictObject({
    ...discoveryBase,
    status: z.literal("initialized"),
    projectId: ProjectMarkerId,
    projectRoot: DirectoryPath,
  }),
  z.strictObject({
    ...discoveryBase,
    status: z.literal("uninitialized"),
  }),
  z.strictObject({
    ...discoveryBase,
    status: z.literal("invalid"),
    projectRoot: DirectoryPath,
    failure: ProjectDiscoveryFailureDto,
  }),
  z.strictObject({
    ...discoveryBase,
    status: z.literal("mismatch"),
    projectRoot: DirectoryPath,
    markerProjectId: ProjectMarkerId,
    registryProjectId: ProjectMarkerId,
  }),
]);
export type ProjectDiscoveryDto = z.infer<typeof ProjectDiscoveryDto>;
export type ProjectDiscoveryDtoInput = z.input<typeof ProjectDiscoveryDto>;

export const parseProjectMarkerDto = (value: unknown): ProjectMarkerDto =>
  z.parse(ProjectMarkerDto, value);
export const tryParseProjectMarkerDto = (value: unknown): ParseOutcome<ProjectMarkerDto> =>
  tryParseWith(ProjectMarkerDto, value, "response");

export const parseProjectInitRequest = (value: unknown): ProjectInitRequest =>
  z.parse(ProjectInitRequest, value);
export const tryParseProjectInitRequest = (value: unknown): ParseOutcome<ProjectInitRequest> =>
  tryParseWith(ProjectInitRequest, value, "request");

export const parseProjectInfoDto = (value: unknown): ProjectInfoDto =>
  z.parse(ProjectInfoDto, value);
export const tryParseProjectInfoDto = (value: unknown): ParseOutcome<ProjectInfoDto> =>
  tryParseWith(ProjectInfoDto, value, "response");

export const parseProjectDiscoveryRequest = (value: unknown): ProjectDiscoveryRequest =>
  z.parse(ProjectDiscoveryRequest, value);
export const tryParseProjectDiscoveryRequest = (
  value: unknown,
): ParseOutcome<ProjectDiscoveryRequest> =>
  tryParseWith(ProjectDiscoveryRequest, value, "request");

export const parseProjectDiscoveryDto = (value: unknown): ProjectDiscoveryDto =>
  z.parse(ProjectDiscoveryDto, value);
export const tryParseProjectDiscoveryDto = (
  value: unknown,
): ParseOutcome<ProjectDiscoveryDto> =>
  tryParseWith(ProjectDiscoveryDto, value, "response");
