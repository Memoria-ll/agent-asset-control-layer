import type {
  ExecutionAuthorizationResult,
  ExecutionOperationKind,
  ResolutionContextInput,
  SkillId,
} from "@aacl/shared";

export type WorkflowStartOrigin =
  | { readonly kind: "advisory_none" }
  | { readonly kind: "bounded_skill_completed"; readonly skillId: SkillId };

const allow = (operation: ExecutionOperationKind): ExecutionAuthorizationResult => ({ decision: "allowed", operation });
const deny = (
  operation: ExecutionOperationKind,
  reason: Extract<ExecutionAuthorizationResult, { decision: "denied" }>["reason"],
): ExecutionAuthorizationResult => {
  switch (reason) {
    case "workflow_selection_required": return { decision: "denied", operation, reason, guidance: { kind: "select_workflow", nextOperation: "workflow_start" } };
    case "skill_selection_required": return { decision: "denied", operation, reason, guidance: { kind: "select_bounded_skill", nextOperation: "bounded_skill" } };
    case "operation_not_allowed_in_mode": return { decision: "denied", operation, reason, guidance: { kind: "use_advisory_mode", requiredMode: "advisory_preparation" } };
    case "workflow_start_requires_advisory_context": return { decision: "denied", operation, reason, guidance: { kind: "use_advisory_mode", requiredMode: "advisory_preparation" } };
    case "workflow_start_requires_completed_skill": return { decision: "denied", operation, reason, guidance: { kind: "complete_bounded_skill", nextOperation: "workflow_start" } };
    case "workflow_already_selected": return { decision: "denied", operation, reason, guidance: { kind: "continue_selected_workflow", nextOperation: "implementation" } };
  }
};

const developmentOperations = new Set<ExecutionOperationKind>(["implementation", "repository_change", "pull_request"]);

/** Authorize only from the explicit current context; no resolver or text is consulted. */
export const authorizeExecutionOperation = (
  operation: ExecutionOperationKind,
  context: ResolutionContextInput,
  startFrom?: WorkflowStartOrigin,
): ExecutionAuthorizationResult => {
  if (operation === "workflow_start") {
    if (context.workflow.kind === "selected") return deny(operation, "workflow_already_selected");
    if (context.executionMode !== "advisory_preparation") return deny(operation, "workflow_start_requires_advisory_context");
    if (context.workflow.kind === "none") return startFrom?.kind === "advisory_none"
      ? allow(operation)
      : deny(operation, "workflow_start_requires_completed_skill");
    if (startFrom?.kind !== "bounded_skill_completed" || startFrom.skillId !== context.workflow.skillId) {
      return deny(operation, "workflow_start_requires_completed_skill");
    }
    return allow(operation);
  }
  if (developmentOperations.has(operation)) {
    return context.workflow.kind === "selected"
      ? allow(operation)
      : deny(operation, "workflow_selection_required");
  }
  if (operation === "bounded_skill") {
    if (context.executionMode !== "advisory_preparation") return deny(operation, "operation_not_allowed_in_mode");
    return context.workflow.kind === "standalone"
      ? allow(operation)
      : deny(operation, "skill_selection_required");
  }
  return allow(operation);
};
