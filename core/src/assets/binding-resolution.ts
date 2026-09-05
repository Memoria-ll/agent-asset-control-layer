import {
  tryParseBindingResolutionRequest,
  type BindingResolutionResponse,
  type BindingSourceDto,
  type CoreErrorDetail,
  type ProjectId,
  type ResolutionContextDto,
  type SelectedStageRequirementsDto,
} from "@aacl/shared";
import {
  coreFailure,
  parseBindingAsset,
  parseWorkflowDefinitionAsset,
  resolveBindings,
  toResolutionConflictDetails,
  type AssetResult,
  type CanonicalBinding,
  type MetadataCatalog,
  type ResolutionEvaluation,
} from "@aacl/core-domain";
import type { StoredAsset } from "./filesystem-store.ts";
import { withFilePath } from "../internal/diagnostics.ts";
import { resolveAssets, type ResolveAssetsOptions, type ResolvedAssets } from "./resolve-assets.ts";
import { sourceIdFor } from "./resolution-input.ts";

const candidateKey = (
  assetId: string,
  revision: string,
  layer: string,
  sourceId: string,
): string => JSON.stringify([assetId, revision, layer, sourceId]);

const storedCandidateKey = (stored: StoredAsset): string => candidateKey(
  String(stored.asset.id),
  String(stored.revision),
  stored.source.kind,
  sourceIdFor(stored.source),
);

const evaluationCandidateKey = (evaluation: ResolutionEvaluation): string => candidateKey(
  String(evaluation.candidate.assetId),
  String(evaluation.candidate.revision),
  evaluation.candidate.source.layer,
  evaluation.candidate.source.sourceId,
);

const publicSource = (stored: StoredAsset): BindingSourceDto => stored.source.kind === "project"
  ? { layer: "project", projectId: stored.source.projectId as ProjectId }
  : { layer: stored.source.kind };

const diagnosticDetails = (resolved: Awaited<ReturnType<typeof resolveAssets>>): CoreErrorDetail[] => {
  if (!resolved.ok) return [];
  const details: CoreErrorDetail[] = [];
  for (const diagnostic of resolved.value.storeDiagnostics) {
    if (diagnostic.failure.details !== undefined) details.push(...diagnostic.failure.details);
  }
  for (const diagnostic of resolved.value.projectionExclusions) {
    const rooted = diagnostic.source.relativePath === undefined
      ? diagnostic.failure
      : withFilePath(diagnostic.source.rootId, diagnostic.source.relativePath, diagnostic.failure);
    if (rooted.details !== undefined) details.push(...rooted.details);
  }
  return details;
};

/**
 * Why the resolver did not keep this candidate, in the shape the response
 * already uses. `included` says nothing a failure needs, so it contributes
 * nothing; the rest carry the ids the caller would otherwise have to guess at.
 */
const evaluationDetails = (evaluation: ResolutionEvaluation): readonly CoreErrorDetail[] => {
  const reason = evaluation.reason;
  const at = (code: string, message: string): CoreErrorDetail => ({
    path: ["asset", String(evaluation.candidate.assetId)],
    code,
    message,
  });
  switch (reason.kind) {
    case "included": return [];
    case "excluded":
      if (reason.cause === "resolution_conflict") return toResolutionConflictDetails(reason.conflict);
      if (reason.cause === "invalid_directory") return reason.diagnostics;
      return [at(reason.cause, `The Workflow Definition was excluded: ${reason.cause}.`)];
    case "overridden": return [at("binding_overridden", "The Workflow Definition was overridden.")];
    case "disabled": return [at("binding_disabled", "The Workflow Definition was disabled.")];
    case "unavailable": return [at(reason.cause, `The Workflow Definition is unavailable: ${reason.cause}.`)];
  }
};

/**
 * What the selected Stage requires, as the Workflow Definition states it, plus
 * the diagnostics explaining an absence.
 *
 * Read from the completed match rather than from the store, because which
 * Definition applies is itself a resolution question: a raw lookup sees a
 * same-ID Project override as two files and calls it ambiguous, and reads a
 * Definition the current scope excludes as if it applied.
 *
 * A Stage that cannot be resolved leaves the requirements absent and says why
 * in the diagnostics; it never fails the request. The candidates are matched
 * against the caller's own context, so they do not depend on this.
 */
const selectedStageRequirements = (
  context: ResolutionContextDto,
  resolved: ResolvedAssets,
  catalog: MetadataCatalog,
): {
  readonly stage?: SelectedStageRequirementsDto;
  readonly diagnostics: readonly CoreErrorDetail[];
} => {
  const selection = context.workflow;
  if (selection.kind !== "selected") return { diagnostics: [] };

  const absent = (code: string, message: string, extra: readonly CoreErrorDetail[] = []) => ({
    diagnostics: [{ path: ["context", "workflow", "workflowId"], code, message }, ...extra],
  });

  const forSelection = resolved.resolution.evaluations.filter((evaluation) =>
    evaluation.candidate.assetType === "workflow"
    && String(evaluation.candidate.assetId) === String(selection.workflowId));
  // A `disable` directive stays `included` — it is the instruction that took the
  // base out — so selecting on inclusion alone picks the directive itself, which
  // has no definition to read and names a Workflow that was switched off.
  const applicable = forSelection.filter((evaluation) =>
    evaluation.reason.kind === "included"
    && evaluation.candidate.rule.operation.kind !== "disable");
  if (applicable.length === 0) {
    return absent(
      "workflow_definition_missing",
      "The selected Workflow Definition does not apply to this context.",
      // Why it does not apply lives in the evaluations that were filtered out;
      // without them the caller sees only that the Workflow is not there.
      forSelection.flatMap((evaluation) => evaluationDetails(evaluation)),
    );
  }
  if (applicable.length > 1) {
    return absent("workflow_definition_conflict", "The selected Workflow Definition is not unique.");
  }

  const key = evaluationCandidateKey(applicable[0]!);
  const stored = resolved.assets.find((asset) => storedCandidateKey(asset) === key);
  if (stored === undefined) {
    return absent(
      "workflow_candidate_missing",
      "A resolved Workflow candidate could not be matched to its stored asset.",
    );
  }
  // No `unresolvedOperationFailure` here, unlike the single-file loader: an
  // `override` that won resolution is the effective Definition, and resolution
  // is what established that.
  const definition = parseWorkflowDefinitionAsset(stored.asset, catalog);
  if (!definition.ok) {
    const rooted = withFilePath(stored.source.rootId, stored.source.relativePath, definition.failure);
    return absent("workflow_definition_invalid", rooted.message, rooted.details ?? []);
  }

  const stage = definition.value.stages.find((item) => item.stageId === selection.stageId);
  if (stage === undefined) {
    return {
      diagnostics: [{
        path: ["context", "workflow", "stageId"],
        code: "workflow_stage_missing",
        message: "The selected Stage is not part of the Workflow Definition.",
      }],
    };
  }

  return {
    stage: {
      stageId: stage.stageId,
      ...(stage.requiredRoleId === undefined ? {} : { requiredRoleId: stage.requiredRoleId }),
      ...(stage.requiredTaskTypeId === undefined ? {} : { requiredTaskTypeId: stage.requiredTaskTypeId }),
    },
    diagnostics: [],
  };
};

/** Resolve Binding Assets through the generic filesystem resolution pipeline. */
export const resolveBindingAssets = async (
  requestInput: unknown,
  options: ResolveAssetsOptions,
  catalog: MetadataCatalog,
): Promise<AssetResult<BindingResolutionResponse>> => {
  const parsed = tryParseBindingResolutionRequest(requestInput);
  if (!parsed.ok) {
    return {
      ok: false,
      failure: coreFailure(parsed.error.code, parsed.error.message, parsed.error.details),
    };
  }

  const { loadingTiers, ...unfilteredRequest } = parsed.value;
  const resolved = await resolveAssets(unfilteredRequest, options);
  if (!resolved.ok) return resolved;
  const selectedStage = selectedStageRequirements(unfilteredRequest.context, resolved.value, catalog);

  const bindingsByCandidate = new Map<string, StoredAsset>();
  for (const stored of resolved.value.assets) {
    if (stored.asset.type !== "binding") continue;
    const parsed = parseBindingAsset(stored.asset);
    if (!parsed.ok) continue;
    bindingsByCandidate.set(storedCandidateKey(stored), stored);
  }

  const entries: {
    readonly binding: CanonicalBinding;
    readonly evaluation: ResolutionEvaluation;
    readonly source: BindingSourceDto;
  }[] = [];
  const diagnostics = [...diagnosticDetails(resolved), ...selectedStage.diagnostics];
  for (const evaluation of resolved.value.resolution.evaluations) {
    if (evaluation.candidate.assetType !== "binding") continue;
    const match = bindingsByCandidate.get(evaluationCandidateKey(evaluation));
    if (match === undefined) {
      return {
        ok: false,
        failure: coreFailure("internal", "A resolved Binding candidate could not be matched to its stored asset.", [{
          path: ["asset", String(evaluation.candidate.assetId)],
          code: "binding_candidate_missing",
          message: "A resolved Binding candidate could not be matched to its stored asset.",
        }]),
      };
    }
    const binding = parseBindingAsset(match.asset);
    if (!binding.ok) continue;
    entries.push({ binding: binding.value, evaluation, source: publicSource(match) });
  }

  const bindingResult = resolveBindings({ entries, catalog });
  if (!bindingResult.ok) return bindingResult;
  diagnostics.push(...bindingResult.value.diagnostics);
  const candidates = loadingTiers === undefined
    ? bindingResult.value.candidates
    : bindingResult.value.candidates.filter((candidate) => loadingTiers.includes(candidate.loadingTier));
  return {
    ok: true,
    value: {
      context: resolved.value.resolution.context,
      candidates: [...candidates],
      ...(selectedStage.stage === undefined ? {} : { stage: selectedStage.stage }),
      ...(diagnostics.length === 0 ? {} : { diagnostics }),
    },
  };
};

export type BindingResolutionServiceResult = AssetResult<BindingResolutionResponse>;
