import type { AssetRevision, WorkflowId } from "@aacl/shared";

export type WorkflowEntryReference = {
  readonly kind: "workflow-reference";
  readonly workflowId: WorkflowId;
  readonly workflowRevision: AssetRevision;
};

export const createWorkflowEntryReference = (
  workflowId: WorkflowId,
  workflowRevision: AssetRevision,
): WorkflowEntryReference => ({
  kind: "workflow-reference",
  workflowId,
  workflowRevision,
});
