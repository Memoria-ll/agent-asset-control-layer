import type {
  AgentExecutionId,
  SessionId,
  SkillId,
  WorkflowStartCommitRequest,
  WorkflowStartResult,
} from "@aacl/shared";
import type { AssetResult } from "@aacl/core-domain";

/** Composite lifecycle boundary owned by the future Session/Agent persistence owner. */
export type WorkflowStartCommitPort = {
  readonly commit: (request: WorkflowStartCommitRequest) => Promise<AssetResult<WorkflowStartResult>>;
};

export type BoundedSkillCompletionReference = {
  readonly agentExecutionId: AgentExecutionId;
  readonly skillId: SkillId;
  readonly sessionId?: SessionId;
};

/** Verify that host lifecycle state records completion of the same bounded Skill execution. */
export type BoundedSkillCompletionVerifier = {
  readonly verify: (reference: BoundedSkillCompletionReference) => Promise<AssetResult<undefined>>;
};
