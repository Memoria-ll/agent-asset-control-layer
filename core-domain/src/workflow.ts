import {
  parseTransitionCandidateDto,
  tryParseWorkflowDefinitionDto,
} from "@aacl/shared";
import type {
  AgentExecutionId,
  AssetId,
  RoleId,
  SnapshotId,
  StageId,
  TaskTypeId,
  TransitionCandidateDto,
  TransitionKind,
  WorkflowDefinitionDto,
  WorkflowId,
  WorkflowStageDto,
  WorkflowStateDto,
  WorkflowStateVersion,
  WorkflowTransitionDto,
} from "@aacl/shared";
import type { CanonicalAsset } from "./assets.ts";
import type { MetadataCatalog } from "./catalog.ts";
import { coreFailure, type AssetResult } from "./failures.ts";

type Detail = { readonly path: string[]; readonly code: string; readonly message: string };

const detail = (
  path: readonly string[],
  code: string,
  message: string,
): Detail => ({ path: [...path], code, message });

const workflowFailure = (
  message: string,
  details: readonly Detail[],
): AssetResult<never> => ({
  ok: false,
  failure: coreFailure("invalid_request", message, details),
});

type GeneralFence = { readonly character: "`" | "~"; readonly length: number };

const generalFenceStart = (line: string): GeneralFence | undefined => {
  const match = /^(?<fence>`{3,}|~{3,})/.exec(line);
  const fence = match?.groups?.fence;
  if (fence === undefined) return undefined;
  return {
    character: fence[0] as "`" | "~",
    length: fence.length,
  };
};

const isGeneralFenceEnd = (line: string, fence: GeneralFence): boolean => {
  const pattern = new RegExp(`^${fence.character}{${fence.length},}[ \\t]*$`);
  return pattern.test(line);
};

const blockFailure = (code: string, message: string): AssetResult<never> =>
  workflowFailure(message, [detail(["document", "body", "aacl-workflow"], code, message)]);

const extractWorkflowPayload = (body: string): AssetResult<string> => {
  const lines = body.split("\n");
  const payloads: string[] = [];
  let generalFence: GeneralFence | undefined;
  let workflowPayload: string[] | undefined;
  let openerInsideUnclosedFence = false;

  for (const line of lines) {
    if (workflowPayload !== undefined) {
      if (line === "```") {
        payloads.push(workflowPayload.join("\n"));
        workflowPayload = undefined;
      } else if (line === "```aacl-workflow") {
        return blockFailure(
          "nested_workflow_fence",
          "A nested aacl-workflow fence is not allowed.",
        );
      } else {
        workflowPayload.push(line);
      }
      continue;
    }

    if (generalFence !== undefined) {
      if (isGeneralFenceEnd(line, generalFence)) {
        generalFence = undefined;
        openerInsideUnclosedFence = false;
      } else if (line === "```aacl-workflow") {
        openerInsideUnclosedFence = true;
      }
      continue;
    }

    if (line === "```aacl-workflow") {
      workflowPayload = [];
      continue;
    }

    const fence = generalFenceStart(line);
    if (fence !== undefined) generalFence = fence;
  }

  if (workflowPayload !== undefined && payloads.length > 0) {
    return blockFailure(
      "duplicate_workflow_block",
      "The asset contains more than one aacl-workflow block.",
    );
  }
  if (workflowPayload !== undefined) {
    return blockFailure(
      "unterminated_workflow_block",
      "The aacl-workflow block has no exact closing fence.",
    );
  }
  if (payloads.length > 1) {
    return blockFailure(
      "duplicate_workflow_block",
      "The asset contains more than one aacl-workflow block.",
    );
  }
  if (payloads.length === 0) {
    return blockFailure(
      openerInsideUnclosedFence ? "workflow_block_inside_fence" : "missing_workflow_block",
      openerInsideUnclosedFence
        ? "The aacl-workflow marker is inside an unterminated fenced block."
        : "The asset does not contain an aacl-workflow block.",
    );
  }
  return { ok: true, value: payloads[0] ?? "" };
};

const parseDefinitionPayload = (payload: string): AssetResult<WorkflowDefinitionDto> => {
  let value: unknown;
  try {
    value = JSON.parse(payload) as unknown;
  } catch {
    return blockFailure("invalid_json", "The aacl-workflow block is not valid JSON.");
  }

  const parsed = tryParseWorkflowDefinitionDto(value);
  if (!parsed.ok) {
    return workflowFailure(
      "The workflow definition has an invalid shape.",
      (parsed.error.details ?? []).map((item) => ({
        path: ["document", "body", "aacl-workflow", ...item.path],
        code: item.code,
        message: item.message,
      })),
    );
  }
  return { ok: true, value: parsed.value };
};

export type ResolvedWorkflowDefinition = Omit<WorkflowDefinitionDto, "workflowId"> & {
  readonly workflowId: WorkflowId;
};

const asWorkflowId = (assetId: AssetId): WorkflowId => assetId as string as WorkflowId;

const validateRequirementArrays = (
  values: readonly string[] | undefined,
  path: readonly string[],
  label: string,
  details: Detail[],
): void => {
  if (values === undefined) return;
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      details.push(detail(
        [...path, String(index)],
        "duplicate_requirement_ref",
        `The ${label} reference "${value}" is declared more than once.`,
      ));
    }
    seen.add(value);
  }
};

const validateDefinitionSemantics = (
  definition: ResolvedWorkflowDefinition,
  catalog: MetadataCatalog,
): AssetResult<ResolvedWorkflowDefinition> => {
  const stageMap = new Map<StageId, WorkflowStageDto>();
  const details: Detail[] = [];

  for (const [index, stage] of definition.stages.entries()) {
    if (stageMap.has(stage.stageId)) {
      details.push(detail(
        ["definition", "stages", String(index), "stageId"],
        "duplicate_stage_id",
        `Stage id "${stage.stageId}" is declared more than once.`,
      ));
    } else {
      stageMap.set(stage.stageId, stage);
    }
    validateRequirementArrays(
      stage.requiredCapabilityRefs,
      ["definition", "stages", String(index), "requiredCapabilityRefs"],
      "capability",
      details,
    );
    validateRequirementArrays(
      stage.requiredArtifactRefs,
      ["definition", "stages", String(index), "requiredArtifactRefs"],
      "artifact",
      details,
    );
  }

  const entryStage = stageMap.get(definition.entryStageId);
  const terminalStage = stageMap.get(definition.terminalStageId);
  if (entryStage === undefined) {
    details.push(detail(
      ["definition", "entryStageId"],
      "unknown_entry_stage",
      `Entry stage "${definition.entryStageId}" is not declared.`,
    ));
  }
  if (terminalStage === undefined) {
    details.push(detail(
      ["definition", "terminalStageId"],
      "unknown_terminal_stage",
      `Terminal stage "${definition.terminalStageId}" is not declared.`,
    ));
  }

  const transitionKeys = new Set<string>();
  for (const [index, transition] of definition.transitions.entries()) {
    if (!stageMap.has(transition.fromStageId)) {
      details.push(detail(
        ["definition", "transitions", String(index), "fromStageId"],
        "unknown_from_stage",
        `Transition source stage "${transition.fromStageId}" is not declared.`,
      ));
    }
    if (!stageMap.has(transition.toStageId)) {
      details.push(detail(
        ["definition", "transitions", String(index), "toStageId"],
        "unknown_to_stage",
        `Transition target stage "${transition.toStageId}" is not declared.`,
      ));
    }
    const transitionKey = JSON.stringify([
      transition.fromStageId,
      transition.toStageId,
      transition.transitionKind,
    ]);
    if (transitionKeys.has(transitionKey)) {
      details.push(detail(
        ["definition", "transitions", String(index)],
        "duplicate_transition",
        "The transition is declared more than once.",
      ));
    } else {
      transitionKeys.add(transitionKey);
    }
    validateRequirementArrays(
      transition.requiredCapabilityRefs,
      ["definition", "transitions", String(index), "requiredCapabilityRefs"],
      "capability",
      details,
    );
    validateRequirementArrays(
      transition.requiredArtifactRefs,
      ["definition", "transitions", String(index), "requiredArtifactRefs"],
      "artifact",
      details,
    );
  }

  if (details.length > 0) return workflowFailure("The workflow definition is invalid.", details);

  for (const transition of definition.transitions) {
    if (
      transition.fromStageId === transition.toStageId &&
      transition.transitionKind !== "retry"
    ) {
      return workflowFailure("The workflow definition is invalid.", [detail(
        ["definition", "transitions"],
        "self_loop",
        `Transition kind "${transition.transitionKind}" cannot loop to the same stage.`,
      )]);
    }
  }

  if (!catalog.roles.has(definition.entryRoleId)) {
    return workflowFailure("The workflow definition is invalid.", [detail(
      ["definition", "entryRoleId"],
      "unknown_entry_role",
      `Entry role "${definition.entryRoleId}" is not in the catalog.`,
    )]);
  }
  if (entryStage?.requiredRoleId === undefined) {
    return workflowFailure("The workflow definition is invalid.", [detail(
      ["definition", "entryStageId", "requiredRoleId"],
      "entry_role_mismatch",
      `Entry stage "${definition.entryStageId}" does not declare a required role.`,
    )]);
  }
  if (entryStage.requiredRoleId !== definition.entryRoleId) {
    return workflowFailure("The workflow definition is invalid.", [detail(
      ["definition", "entryStageId", "requiredRoleId"],
      "entry_role_mismatch",
      `Entry stage "${definition.entryStageId}" requires role "${entryStage.requiredRoleId}", but entryRoleId is "${definition.entryRoleId}".`,
    )]);
  }

  for (const [index, stage] of definition.stages.entries()) {
    if (stage.requiredRoleId !== undefined && !catalog.roles.has(stage.requiredRoleId)) {
      details.push(detail(
        ["definition", "stages", String(index), "requiredRoleId"],
        "unknown_role",
        `Role "${stage.requiredRoleId}" is not in the catalog.`,
      ));
    }
    if (stage.requiredTaskTypeId !== undefined && !catalog.taskTypes.has(stage.requiredTaskTypeId)) {
      details.push(detail(
        ["definition", "stages", String(index), "requiredTaskTypeId"],
        "unknown_task_type",
        `Task type "${stage.requiredTaskTypeId}" is not in the catalog.`,
      ));
    }
  }
  if (details.length > 0) return workflowFailure("The workflow definition is invalid.", details);

  const reachableFromEntry = reachableStages(definition.entryStageId, definition.transitions);
  const unreachableStages = definition.stages.filter((stage) => !reachableFromEntry.has(stage.stageId));
  if (unreachableStages.length > 0) {
    return workflowFailure("The workflow definition is invalid.", unreachableStages.map((stage) => detail(
      ["definition", "stages"],
      "unreachable_stage",
      `Stage "${stage.stageId}" cannot be reached from the entry stage.`,
    )));
  }

  const reverseTransitions = definition.transitions.map((transition) => ({
    fromStageId: transition.toStageId,
    toStageId: transition.fromStageId,
  }));
  const canReachTerminal = reachableStages(definition.terminalStageId, reverseTransitions);
  const unreachableTerminal = definition.stages.filter((stage) => !canReachTerminal.has(stage.stageId));
  if (unreachableTerminal.length > 0) {
    return workflowFailure("The workflow definition is invalid.", unreachableTerminal.map((stage) => detail(
      ["definition", "stages"],
      "unreachable_terminal",
      `Stage "${stage.stageId}" cannot reach the terminal stage.`,
    )));
  }

  const badCycle = findBadCycle(definition.stages, definition.transitions);
  if (badCycle !== undefined) {
    return workflowFailure("The workflow definition is invalid.", [detail(
      ["definition", "transitions"],
      "cycle_without_retry_or_return",
      `Stages "${badCycle[0]}" and "${badCycle[1]}" form a cycle without retry or return.`,
    )]);
  }

  return { ok: true, value: definition };
};

const reachableStages = (
  start: StageId,
  transitions: readonly { readonly fromStageId: StageId; readonly toStageId: StageId }[],
): Set<StageId> => {
  const adjacency = new Map<StageId, StageId[]>();
  for (const transition of transitions) {
    const outgoing = adjacency.get(transition.fromStageId) ?? [];
    outgoing.push(transition.toStageId);
    adjacency.set(transition.fromStageId, outgoing);
  }
  const visited = new Set<StageId>();
  const pending: StageId[] = [start];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    for (const next of adjacency.get(current) ?? []) {
      if (!visited.has(next)) pending.push(next);
    }
  }
  return visited;
};

const findBadCycle = (
  stages: readonly WorkflowStageDto[],
  transitions: readonly WorkflowTransitionDto[],
): readonly [StageId, StageId] | undefined => {
  const adjacency = new Map<StageId, StageId[]>();
  for (const transition of transitions) {
    if (transition.transitionKind === "retry" || transition.transitionKind === "return") continue;
    const outgoing = adjacency.get(transition.fromStageId) ?? [];
    outgoing.push(transition.toStageId);
    adjacency.set(transition.fromStageId, outgoing);
  }

  let nextIndex = 0;
  const indices = new Map<StageId, number>();
  const lowLinks = new Map<StageId, number>();
  const stack: StageId[] = [];
  const onStack = new Set<StageId>();
  let result: readonly [StageId, StageId] | undefined;

  const visit = (stageId: StageId): void => {
    indices.set(stageId, nextIndex);
    lowLinks.set(stageId, nextIndex);
    nextIndex += 1;
    stack.push(stageId);
    onStack.add(stageId);

    for (const target of adjacency.get(stageId) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(stageId, Math.min(lowLinks.get(stageId) ?? 0, lowLinks.get(target) ?? 0));
      } else if (onStack.has(target)) {
        lowLinks.set(stageId, Math.min(lowLinks.get(stageId) ?? 0, indices.get(target) ?? 0));
      }
    }

    if (lowLinks.get(stageId) !== indices.get(stageId)) return;
    const component: StageId[] = [];
    let member: StageId | undefined;
    do {
      member = stack.pop();
      if (member !== undefined) {
        onStack.delete(member);
        component.push(member);
      }
    } while (member !== stageId);
    if (component.length >= 2 && result === undefined) {
      result = [component[0] as StageId, component[1] as StageId];
    }
  };

  for (const stage of stages) {
    if (!indices.has(stage.stageId)) visit(stage.stageId);
    if (result !== undefined) break;
  }
  return result;
};

/** Parse an asset body and validate its resolved workflow semantics. */
export const parseWorkflowDefinitionAsset = (
  asset: CanonicalAsset,
  catalog: MetadataCatalog,
): AssetResult<ResolvedWorkflowDefinition> => {
  if (asset.type !== "workflow") {
    return workflowFailure("The asset is not a workflow definition.", [detail(
      ["document", "frontmatter", "type"],
      "wrong_asset_type",
      "Asset type must be \"workflow\".",
    )]);
  }

  const payload = extractWorkflowPayload(asset.body);
  if (!payload.ok) return payload;
  const parsed = parseDefinitionPayload(payload.value);
  if (!parsed.ok) return parsed;

  if (parsed.value.workflowId !== undefined && parsed.value.workflowId !== asWorkflowId(asset.id)) {
    return workflowFailure("The workflow definition does not match the asset identity.", [detail(
      ["document", "body", "aacl-workflow", "workflowId"],
      "workflow_id_mismatch",
      `Workflow id "${parsed.value.workflowId}" does not match asset id "${asset.id}".`,
    )]);
  }

  const resolved: ResolvedWorkflowDefinition = {
    workflowId: parsed.value.workflowId ?? asWorkflowId(asset.id),
    entryRoleId: parsed.value.entryRoleId,
    entryStageId: parsed.value.entryStageId,
    terminalStageId: parsed.value.terminalStageId,
    stages: parsed.value.stages,
    transitions: parsed.value.transitions,
  };
  return validateWorkflowDefinition(resolved, catalog);
};

/** Validate graph, catalog references, and workflow cycles. */
export const validateWorkflowDefinition = (
  definition: ResolvedWorkflowDefinition,
  catalog: MetadataCatalog,
): AssetResult<ResolvedWorkflowDefinition> => validateDefinitionSemantics(definition, catalog);

export type WorkflowStateSeed = {
  readonly workflowId: WorkflowId;
  readonly currentStageId: StageId;
  readonly entryRoleId: RoleId;
  readonly currentRoleId: RoleId;
  readonly linkedAgentExecutionIds: readonly AgentExecutionId[];
  readonly linkedSnapshotIds: readonly SnapshotId[];
};

export type WorkflowStateLinks = {
  readonly linkedAgentExecutionIds: readonly AgentExecutionId[];
  readonly linkedSnapshotIds: readonly SnapshotId[];
};

/** Create the initial state fields owned by the domain. */
export const initializeWorkflowState = (
  definition: ResolvedWorkflowDefinition,
  links: WorkflowStateLinks,
): WorkflowStateSeed => {
  return {
    workflowId: definition.workflowId,
    currentStageId: definition.entryStageId,
    entryRoleId: definition.entryRoleId,
    currentRoleId: definition.entryRoleId,
    linkedAgentExecutionIds: [...links.linkedAgentExecutionIds],
    linkedSnapshotIds: [...links.linkedSnapshotIds],
  };
};

export type WorkflowEvaluationInput = {
  readonly roleId?: RoleId;
  readonly taskTypeId?: TaskTypeId;
  readonly availableCapabilityRefs: readonly string[];
  readonly availableArtifactRefs: readonly string[];
};

export type WorkflowStateMutation = {
  readonly workflowId: WorkflowId;
  readonly executionInstanceId: WorkflowStateDto["executionInstanceId"];
  readonly stateVersion: WorkflowStateVersion;
  readonly currentStageId: StageId;
  readonly entryRoleId: RoleId;
  readonly currentRoleId: RoleId;
  readonly linkedAgentExecutionIds: readonly AgentExecutionId[];
  readonly linkedSnapshotIds: readonly SnapshotId[];
};

export type WorkflowTransitionSelection = {
  readonly toStageId: StageId;
  readonly transitionKind: TransitionKind;
  readonly expectedStateVersion: WorkflowStateVersion;
};

const stateMismatch = (): AssetResult<never> => workflowFailure(
  "The workflow state does not belong to the definition.",
  [detail(
    ["workflowState"],
    "state_definition_mismatch",
    "The workflow state workflowId or currentStageId does not match the definition.",
  )],
);

const getCurrentStage = (
  definition: ResolvedWorkflowDefinition,
  state: WorkflowStateDto,
): WorkflowStageDto | undefined =>
  state.workflowId === definition.workflowId
    ? definition.stages.find((stage) => stage.stageId === state.currentStageId)
    : undefined;

const missingRequirements = (
  target: WorkflowStageDto,
  transition: WorkflowTransitionDto,
  input: WorkflowEvaluationInput,
  state: WorkflowStateDto,
  definition: ResolvedWorkflowDefinition,
): string[] => {
  const reasons: string[] = [];
  if (target.requiredRoleId !== undefined && input.roleId !== target.requiredRoleId) {
    reasons.push(`Required role "${target.requiredRoleId}" is not available.`);
  }
  if (target.requiredTaskTypeId !== undefined && input.taskTypeId !== target.requiredTaskTypeId) {
    reasons.push(`Required task type "${target.requiredTaskTypeId}" is not available.`);
  }

  const capabilities = new Set(input.availableCapabilityRefs);
  const seenCapabilities = new Set<string>();
  for (const ref of [...(target.requiredCapabilityRefs ?? []), ...(transition.requiredCapabilityRefs ?? [])]) {
    if (seenCapabilities.has(ref)) continue;
    seenCapabilities.add(ref);
    if (!capabilities.has(ref)) reasons.push(`Required capability "${ref}" is not available.`);
  }

  const artifacts = new Set(input.availableArtifactRefs);
  const seenArtifacts = new Set<string>();
  for (const ref of [...(target.requiredArtifactRefs ?? []), ...(transition.requiredArtifactRefs ?? [])]) {
    if (seenArtifacts.has(ref)) continue;
    seenArtifacts.add(ref);
    if (!artifacts.has(ref)) reasons.push(`Required artifact "${ref}" is not available.`);
  }

  if (
    state.currentStageId === definition.terminalStageId &&
    transition.transitionKind !== "retry" &&
    transition.transitionKind !== "return"
  ) {
    reasons.push("The workflow is already at its terminal stage, so this transition is not available.");
  }
  return reasons;
};

/** Evaluate every declared outgoing transition without changing state. */
export const possibleWorkflowTransitions = (
  definition: ResolvedWorkflowDefinition,
  state: WorkflowStateDto,
  input: WorkflowEvaluationInput,
): AssetResult<readonly TransitionCandidateDto[]> => {
  const currentStage = getCurrentStage(definition, state);
  if (currentStage === undefined) return stateMismatch();

  const candidates: TransitionCandidateDto[] = [];
  for (const transition of definition.transitions) {
    if (transition.fromStageId !== currentStage.stageId) continue;
    const target = definition.stages.find((stage) => stage.stageId === transition.toStageId);
    if (target === undefined) return stateMismatch();
    const roleAndTask = {
      ...(target.requiredRoleId !== undefined ? { requiredRoleId: target.requiredRoleId } : {}),
      ...(target.requiredTaskTypeId !== undefined ? { requiredTaskTypeId: target.requiredTaskTypeId } : {}),
    };
    const reasons = missingRequirements(target, transition, input, state, definition);
    const base = {
      toStageId: transition.toStageId,
      transitionKind: transition.transitionKind,
      stateVersion: state.stateVersion,
      ...roleAndTask,
    };
    candidates.push(reasons.length > 0
      ? parseTransitionCandidateDto({ ...base, blocked: true, blockedReasons: reasons })
      : parseTransitionCandidateDto({ ...base, blocked: false }));
  }
  return { ok: true, value: candidates };
};

const transitionConflict = (): AssetResult<never> => ({
  ok: false,
  failure: coreFailure("conflict", "The workflow state version no longer matches the update precondition.", [detail(
    ["workflowState", "stateVersion"],
    "state_version_conflict",
    "The workflow state version no longer matches the update precondition.",
  )]),
});

const transitionNotDeclared = (): AssetResult<never> => workflowFailure(
  "The requested workflow transition is not declared.",
  [detail(["transition"], "transition_not_declared", "The requested workflow transition is not declared.")],
);

const transitionBlocked = (reasons: readonly string[]): AssetResult<never> => workflowFailure(
  "The requested workflow transition is blocked.",
  [detail(["transition"], "transition_blocked", reasons.join(" "))],
);

/**
 * Re-evaluate and apply only the transition explicitly selected by the caller.
 *
 * `selection` carries `expectedStateVersion` as its own field rather than being a
 * `TransitionCandidateDto`. A candidate already holds the version it was evaluated
 * against, so accepting one here would let the precondition be read off whatever the
 * query happened to return instead of off the state the caller decided on.
 */
export const applyWorkflowTransition = (
  definition: ResolvedWorkflowDefinition,
  state: WorkflowStateDto,
  selection: WorkflowTransitionSelection,
  input: WorkflowEvaluationInput,
): AssetResult<WorkflowStateMutation> => {
  const resolvedSelection = selection;
  const evaluation = input;

  if (state.workflowId !== definition.workflowId || getCurrentStage(definition, state) === undefined) {
    return stateMismatch();
  }
  if (resolvedSelection.expectedStateVersion !== state.stateVersion) return transitionConflict();

  const candidates = possibleWorkflowTransitions(definition, state, evaluation);
  if (!candidates.ok) return candidates;
  const candidate = candidates.value.find(
    (value) => value.toStageId === resolvedSelection.toStageId && value.transitionKind === resolvedSelection.transitionKind,
  );
  if (candidate === undefined) return transitionNotDeclared();
  if (candidate.blocked) return transitionBlocked(candidate.blockedReasons);

  const target = definition.stages.find((stage) => stage.stageId === candidate.toStageId);
  if (target === undefined) return transitionNotDeclared();
  return {
    ok: true,
    value: {
      workflowId: state.workflowId,
      executionInstanceId: state.executionInstanceId,
      stateVersion: (state.stateVersion + 1) as WorkflowStateVersion,
      currentStageId: target.stageId,
      entryRoleId: state.entryRoleId,
      currentRoleId: target.requiredRoleId ?? state.currentRoleId,
      linkedAgentExecutionIds: [...state.linkedAgentExecutionIds],
      linkedSnapshotIds: [...state.linkedSnapshotIds],
    },
  };
};
