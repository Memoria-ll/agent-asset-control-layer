import type {
  ExecutionAuthorizationResult,
  ExecutionOperationKind,
  ResolutionContextInput,
  SkillId,
} from "@aacl/shared";

export type WorkflowStartOrigin =
  | { readonly kind: "advisory_none" }
  | { readonly kind: "verified_bounded_skill_completion"; readonly skillId: SkillId };

const allow = (operation: ExecutionOperationKind): ExecutionAuthorizationResult => ({ decision: "allowed", operation });
type DevelopmentOperation = "implementation" | "repository_change" | "pull_request";
const denyWorkflowSelection = (operation: DevelopmentOperation): ExecutionAuthorizationResult => ({ decision: "denied", operation, reason: "workflow_selection_required", guidance: { kind: "select_workflow", nextOperation: "workflow_start" } });
const denySkillSelection = (): ExecutionAuthorizationResult => ({ decision: "denied", operation: "bounded_skill", reason: "skill_selection_required", guidance: { kind: "select_bounded_skill", nextOperation: "bounded_skill" } });
const denyBoundedSkillMode = (): ExecutionAuthorizationResult => ({ decision: "denied", operation: "bounded_skill", reason: "operation_not_allowed_in_mode", guidance: { kind: "use_advisory_mode", requiredMode: "advisory_preparation" } });
const denyDevelopmentMode = (operation: DevelopmentOperation): ExecutionAuthorizationResult => ({ decision: "denied", operation, reason: "development_mode_required", guidance: { kind: "use_development_mode", requiredMode: "development_execution" } });
const denyWorkflowStartMode = (): ExecutionAuthorizationResult => ({ decision: "denied", operation: "workflow_start", reason: "workflow_start_requires_advisory_context", guidance: { kind: "use_advisory_mode", requiredMode: "advisory_preparation" } });
const denyWorkflowStartCompletion = (): ExecutionAuthorizationResult => ({ decision: "denied", operation: "workflow_start", reason: "workflow_start_requires_completed_skill", guidance: { kind: "complete_bounded_skill", nextOperation: "workflow_start" } });
const denySelectedWorkflowStart = (): ExecutionAuthorizationResult => ({ decision: "denied", operation: "workflow_start", reason: "workflow_already_selected", guidance: { kind: "continue_selected_workflow", nextOperation: "implementation" } });

const developmentOperations = new Set<ExecutionOperationKind>(["implementation", "repository_change", "pull_request"]);
const isDevelopmentOperation = (operation: ExecutionOperationKind): operation is DevelopmentOperation => developmentOperations.has(operation);

/** Authorize only from the explicit current context; no resolver or text is consulted. */
export const authorizeExecutionOperation = (
  operation: ExecutionOperationKind,
  context: ResolutionContextInput,
  startFrom?: WorkflowStartOrigin,
): ExecutionAuthorizationResult => {
  if (operation === "workflow_start") {
    if (context.workflow.kind === "selected") return denySelectedWorkflowStart();
    if (context.executionMode !== "advisory_preparation") return denyWorkflowStartMode();
    if (context.workflow.kind === "none") return startFrom?.kind === "advisory_none"
      ? allow(operation)
      : denyWorkflowStartCompletion();
    if (startFrom?.kind !== "verified_bounded_skill_completion" || startFrom.skillId !== context.workflow.skillId) {
      return denyWorkflowStartCompletion();
    }
    return allow(operation);
  }
  if (isDevelopmentOperation(operation)) {
    if (context.workflow.kind !== "selected") return denyWorkflowSelection(operation);
    return context.executionMode === "development_execution" ? allow(operation) : denyDevelopmentMode(operation);
  }
  if (operation === "bounded_skill") {
    if (context.executionMode !== "advisory_preparation") return denyBoundedSkillMode();
    return context.workflow.kind === "standalone"
      ? allow(operation)
      : denySkillSelection();
  }
  return allow(operation);
};
