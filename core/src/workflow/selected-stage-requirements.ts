import {
  tryParseSelectedStageRequirementsRequest,
  type CoreErrorDetail,
  type ResolutionContextDto,
  type SelectedStageRequirementsDto,
  type SelectedStageRequirementsResponse,
} from "@aacl/shared";
import {
  coreFailure,
  parseWorkflowDefinitionAsset,
  toResolutionConflictDetails,
  type AssetResult,
  type MetadataCatalog,
  type ResolutionEvaluation,
} from "@aacl/core-domain";
import { withFilePath } from "../internal/diagnostics.ts";
import type { StoredAsset } from "../assets/filesystem-store.ts";
import { resolveAssets, type ResolveAssetsOptions, type ResolvedAssets } from "../assets/resolve-assets.ts";
import { sourceIdFor } from "../assets/resolution-input.ts";

const candidateKey = (assetId: string, revision: string, layer: string, sourceId: string): string =>
  JSON.stringify([assetId, revision, layer, sourceId]);
const storedCandidateKey = (stored: StoredAsset): string => candidateKey(
  String(stored.asset.id), String(stored.revision), stored.source.kind, sourceIdFor(stored.source),
);
const evaluationCandidateKey = (evaluation: ResolutionEvaluation): string => candidateKey(
  String(evaluation.candidate.assetId), String(evaluation.candidate.revision),
  evaluation.candidate.source.layer, evaluation.candidate.source.sourceId,
);

const evaluationDetails = (evaluation: ResolutionEvaluation): readonly CoreErrorDetail[] => {
  const reason = evaluation.reason;
  const at = (code: string, message: string): CoreErrorDetail => ({
    path: ["asset", String(evaluation.candidate.assetId)], code, message,
  });
  switch (reason.kind) {
    case "included": return [];
    case "excluded":
      if (reason.cause === "resolution_conflict") return toResolutionConflictDetails(reason.conflict);
      if (reason.cause === "invalid_directory") return reason.diagnostics;
      return [at(reason.cause, `The Workflow Definition was excluded: ${reason.cause}.`)];
    case "overridden": return [at("workflow_overridden", "The Workflow Definition was overridden.")];
    case "disabled": return [at("workflow_disabled", "The Workflow Definition was disabled.")];
    case "unavailable": return [at(reason.cause, `The Workflow Definition is unavailable: ${reason.cause}.`)];
  }
};

const assetDiagnosticDetails = (resolved: ResolvedAssets): readonly CoreErrorDetail[] => {
  const details: CoreErrorDetail[] = [];
  for (const diagnostic of resolved.storeDiagnostics) {
    if (diagnostic.failure.details !== undefined) details.push(...diagnostic.failure.details);
  }
  for (const diagnostic of resolved.projectionExclusions) {
    const rooted = diagnostic.source.relativePath === undefined
      ? diagnostic.failure
      : withFilePath(diagnostic.source.rootId, diagnostic.source.relativePath, diagnostic.failure);
    if (rooted.details !== undefined) details.push(...rooted.details);
  }
  return details;
};

const selectRequirements = (
  context: ResolutionContextDto,
  resolved: ResolvedAssets,
  catalog: MetadataCatalog,
): {
  readonly requirements?: SelectedStageRequirementsDto;
  readonly diagnostics?: readonly CoreErrorDetail[];
} => {
  const selection = context.workflow;
  if (selection.kind !== "selected") return {
    diagnostics: [{
      path: ["context", "workflow", "kind"],
      code: "workflow_selection_required",
      message: "A selected Workflow and Stage are required.",
    }],
  };
  const absent = (code: string, message: string, extra: readonly CoreErrorDetail[] = []) => ({
    diagnostics: [{ path: ["context", "workflow", "workflowId"], code, message }, ...extra],
  });
  const forSelection = resolved.resolution.evaluations.filter((evaluation) =>
    evaluation.candidate.assetType === "workflow"
    && String(evaluation.candidate.assetId) === String(selection.workflowId));
  const applicable = forSelection.filter((evaluation) =>
    evaluation.reason.kind === "included" && evaluation.candidate.rule.operation.kind !== "disable");
  if (applicable.length === 0) {
    return absent(
      "workflow_definition_missing",
      "The selected Workflow Definition does not apply to this context.",
      forSelection.flatMap(evaluationDetails),
    );
  }
  if (applicable.length > 1) {
    return absent("workflow_definition_conflict", "The selected Workflow Definition is not unique.");
  }
  const stored = resolved.assets.find((asset) => storedCandidateKey(asset) === evaluationCandidateKey(applicable[0]!));
  if (stored === undefined) {
    return absent("workflow_candidate_missing", "A resolved Workflow candidate could not be matched to its stored asset.");
  }
  const definition = parseWorkflowDefinitionAsset(stored.asset, catalog);
  if (!definition.ok) {
    const rooted = withFilePath(stored.source.rootId, stored.source.relativePath, definition.failure);
    return absent("workflow_definition_invalid", rooted.message, rooted.details ?? []);
  }
  const stage = definition.value.stages.find((item) => item.stageId === selection.stageId);
  if (stage === undefined) return {
    diagnostics: [{
      path: ["context", "workflow", "stageId"],
      code: "workflow_stage_missing",
      message: "The selected Stage is not part of the Workflow Definition.",
    }],
  };
  return { requirements: {
    workflowId: selection.workflowId,
    stageId: stage.stageId,
    ...(stage.requiredRoleId === undefined ? {} : { requiredRoleId: stage.requiredRoleId }),
    ...(stage.requiredTaskTypeId === undefined ? {} : { requiredTaskTypeId: stage.requiredTaskTypeId }),
  } };
};

/** Resolve only the selected Stage's declared Role and Task Type requirements. */
export const resolveSelectedStageRequirements = async (
  requestInput: unknown,
  options: ResolveAssetsOptions,
  catalog: MetadataCatalog,
): Promise<AssetResult<SelectedStageRequirementsResponse>> => {
  const parsed = tryParseSelectedStageRequirementsRequest(requestInput);
  if (!parsed.ok) return {
    ok: false,
    failure: coreFailure(parsed.error.code, parsed.error.message, parsed.error.details),
  };
  const resolved = await resolveAssets(parsed.value, { ...options, metadataCatalog: catalog });
  if (!resolved.ok) return resolved;
  const selected = selectRequirements(resolved.value.resolution.context, resolved.value, catalog);
  const diagnostics = [...(selected.diagnostics ?? []), ...assetDiagnosticDetails(resolved.value)];
  return {
    ok: true,
    value: {
      context: resolved.value.resolution.context,
      ...(selected.requirements === undefined
        ? { outcome: "unavailable" as const, diagnostics }
        : {
            outcome: "resolved" as const,
            requirements: selected.requirements,
            ...(diagnostics.length === 0 ? {} : { diagnostics }),
          }),
    },
  };
};

export type SelectedStageRequirementsServiceResult = AssetResult<SelectedStageRequirementsResponse>;
