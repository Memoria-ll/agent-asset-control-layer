import type { WorkflowStartCommitRequest, WorkflowStartResult } from "@aacl/shared";
import type { AssetResult } from "@aacl/core-domain";

/** Composite lifecycle boundary owned by the future Session/Agent persistence owner. */
export type WorkflowStartCommitPort = {
  readonly commit: (request: WorkflowStartCommitRequest) => Promise<AssetResult<WorkflowStartResult>>;
};
