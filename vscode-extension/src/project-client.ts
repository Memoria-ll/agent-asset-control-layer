import type {
  ProjectDiscoveryDto,
  ProjectDiscoveryRequestInput,
  ProjectInfoDto,
  ProjectInitRequestInput,
} from "@aacl/shared";

/** Transport-neutral operations used by the future command/UI wiring in #31. */
export type ProjectClient = {
  readonly initialize: (request: ProjectInitRequestInput) => Promise<ProjectInfoDto>;
  readonly discover: (request: ProjectDiscoveryRequestInput) => Promise<ProjectDiscoveryDto>;
};
