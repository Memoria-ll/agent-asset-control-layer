import {
  tryParseBindingResolutionRequest,
  type BindingResolutionResponse,
  type BindingSourceDto,
  type CoreErrorDetail,
  type ProjectId,
  type ResolutionContextDto,
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
 * The Role and Task Type the selected Stage requires, which the Workflow
 * Definition owns and no Binding repeats. `undefined` means the context already
 * carries every axis this can supply, so nothing has to be resolved again.
 *
 * Read from a completed match rather than from the store, because which
 * Definition applies is itself a resolution question: a raw lookup sees a
 * same-ID Project override as two files and calls it ambiguous, and reads a
 * Definition the current scope excludes as if it applied.
 */
const workflowStageContext = (
  context: ResolutionContextDto,
  resolved: ResolvedAssets,
  catalog: MetadataCatalog,
): AssetResult<ResolutionContextDto | undefined> => {
  const selection = context.workflow;
  if (selection.kind !== "selected") return { ok: true, value: undefined };
  if (context.roleId !== undefined && context.taskTypeId !== undefined) return { ok: true, value: undefined };

  const workflowFailure = (
    code: "not_found" | "conflict" | "invalid_request",
    message: string,
    path: readonly string[],
    detailCode: string,
    evaluationReasons: readonly CoreErrorDetail[] = [],
  ): AssetResult<never> => ({
    ok: false,
    failure: coreFailure(code, message, [
      { path: [...path], code: detailCode, message },
      ...evaluationReasons,
      // A file the store could not read is absent from the resolution, so the
      // Workflow reads as missing for a reason only these carry.
      ...diagnosticDetails({ ok: true, value: resolved }),
    ]),
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
    return workflowFailure(
      "not_found",
      "The selected Workflow Definition does not apply to this context.",
      ["context", "workflow", "workflowId"],
      "workflow_definition_missing",
      // Why it does not apply lives in the evaluations that were filtered out;
      // without them the caller sees only that the Workflow is not there.
      forSelection.flatMap((evaluation) => evaluationDetails(evaluation)),
    );
  }
  if (applicable.length > 1) {
    return workflowFailure(
      "conflict",
      "The selected Workflow Definition is not unique.",
      ["context", "workflow", "workflowId"],
      "workflow_definition_conflict",
    );
  }

  const key = evaluationCandidateKey(applicable[0]!);
  const stored = resolved.assets.find((asset) => storedCandidateKey(asset) === key);
  if (stored === undefined) {
    return {
      ok: false,
      failure: coreFailure("internal", "A resolved Workflow candidate could not be matched to its stored asset.", [{
        path: ["context", "workflow", "workflowId"],
        code: "workflow_candidate_missing",
        message: "A resolved Workflow candidate could not be matched to its stored asset.",
      }]),
    };
  }
  // No `unresolvedOperationFailure` here, unlike the single-file loader: an
  // `override` that won resolution is the effective Definition, and resolution
  // is what established that.
  const definition = parseWorkflowDefinitionAsset(stored.asset, catalog);
  if (!definition.ok) {
    return {
      ok: false,
      failure: withFilePath(stored.source.rootId, stored.source.relativePath, definition.failure),
    };
  }

  const stage = definition.value.stages.find((item) => item.stageId === selection.stageId);
  if (stage === undefined) {
    const message = "The selected Stage is not part of the Workflow Definition.";
    return {
      ok: false,
      failure: coreFailure("invalid_request", message, [{
        path: ["context", "workflow", "stageId"],
        code: "workflow_stage_missing",
        message,
      }]),
    };
  }

  const derivedAxes = {
    ...(context.roleId === undefined && stage.requiredRoleId !== undefined
      ? { roleId: stage.requiredRoleId }
      : {}),
    ...(context.taskTypeId === undefined && stage.requiredTaskTypeId !== undefined
      ? { taskTypeId: stage.requiredTaskTypeId }
      : {}),
  };
  return Object.keys(derivedAxes).length === 0
    ? { ok: true, value: undefined }
    : { ok: true, value: { ...context, ...derivedAxes } };
};

/** Resolve Binding Assets through the generic filesystem resolution pipeline. */
export const resolveBindingAssets = async (
  requestInput: unknown,
  // `deriveContext` is not among them: this service owns the Workflow Stage
  // projection, so a caller-supplied hook could only be one that is never run.
  options: Omit<ResolveAssetsOptions, "deriveContext">,
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
  const resolved = await resolveAssets(unfilteredRequest, {
    ...options,
    deriveContext: (context, firstMatch) => workflowStageContext(context, firstMatch, catalog),
  });
  if (!resolved.ok) return resolved;

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
  const diagnostics = diagnosticDetails(resolved);
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
      ...(diagnostics.length === 0 ? {} : { diagnostics }),
    },
  };
};

export type BindingResolutionServiceResult = AssetResult<BindingResolutionResponse>;
