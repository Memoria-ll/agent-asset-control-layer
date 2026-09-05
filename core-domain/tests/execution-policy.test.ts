import { describe, expect, it } from "vitest";
import { authorizeExecutionOperation } from "../src/index.ts";
import type { ResolutionContextInput, SkillId } from "@aacl/shared";

const none: ResolutionContextInput = { executionMode: "advisory_preparation", workflow: { kind: "none" } };
const skill: ResolutionContextInput = { executionMode: "advisory_preparation", workflow: { kind: "standalone", skillId: "skill-a" as SkillId } };
const selected: ResolutionContextInput = { executionMode: "development_execution", workflow: { kind: "selected", workflowId: "flow-a", workflowRevision: "sha256:flow-a", stageId: "start" } };

describe("execution operation policy", () => {
  it("allows only explicit advisory origins to start a workflow", () => {
    expect(authorizeExecutionOperation("workflow_start", none, { kind: "advisory_none" })).toEqual({ decision: "allowed", operation: "workflow_start" });
    expect(authorizeExecutionOperation("workflow_start", skill, { kind: "bounded_skill_completed", skillId: "skill-a" as SkillId })).toEqual({ decision: "allowed", operation: "workflow_start" });
    expect(authorizeExecutionOperation("workflow_start", skill, { kind: "bounded_skill_completed", skillId: "skill-b" as SkillId })).toMatchObject({ decision: "denied", reason: "workflow_start_requires_completed_skill" });
    expect(authorizeExecutionOperation("workflow_start", selected, { kind: "advisory_none" })).toMatchObject({ decision: "denied", reason: "workflow_already_selected" });
  });

  it("does not let a standalone Skill grant development operations", () => {
    expect(authorizeExecutionOperation("bounded_skill", selected)).toMatchObject({ decision: "denied", reason: "operation_not_allowed_in_mode" });
    expect(authorizeExecutionOperation("implementation", skill)).toMatchObject({ decision: "denied", reason: "workflow_selection_required" });
    expect(authorizeExecutionOperation("repository_change", selected)).toEqual({ decision: "allowed", operation: "repository_change" });
    expect(authorizeExecutionOperation("pull_request", selected)).toEqual({ decision: "allowed", operation: "pull_request" });
  });
});
