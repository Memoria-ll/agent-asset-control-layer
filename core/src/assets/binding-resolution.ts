import {
  tryParseBindingResolutionRequest,
  type BindingResolutionResponse,
  type BindingSourceDto,
  type CoreErrorDetail,
  type ProjectId,
} from "@aacl/shared";
import {
  coreFailure,
  parseBindingAsset,
  resolveBindings,
  type AssetResult,
  type CanonicalBinding,
  type MetadataCatalog,
  type ResolutionEvaluation,
} from "@aacl/core-domain";
import type { StoredAsset } from "./filesystem-store.ts";
import { withFilePath } from "../internal/diagnostics.ts";
import { resolveAssets, type ResolveAssetsOptions } from "./resolve-assets.ts";
import { sourceIdFor } from "./resolution-input.ts";
import { selectWorkflowDefinition } from "../workflow/filesystem-definition-loader.ts";

/**
 * Fill the Role and Task Type the selected Stage requires, which the Workflow
 * Definition owns and no Binding repeats. Without it scope matching reads those
 * axes as absent and therefore neutral, so a Binding scoped to any other Role
 * stays eligible for the selected Stage. An axis the caller supplied is left
 * alone: it is the caller's own input, not a value derived here.
 */
const workflowStageContext = (
  catalog: MetadataCatalog,
): NonNullable<ResolveAssetsOptions["deriveContext"]> => (context, assets) => {
  const selection = context.workflow;
  if (selection.kind !== "selected") return { ok: true, value: context };
  if (context.roleId !== undefined && context.taskTypeId !== undefined) return { ok: true, value: context };

  const matches = assets.filter((stored) => String(stored.asset.id) === String(selection.workflowId));
  const selected = selectWorkflowDefinition(matches, catalog);
  if (!selected.ok) return selected;

  const stage = selected.value.definition.stages.find((item) => item.stageId === selection.stageId);
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
  return { ok: true, value: { ...context, ...derivedAxes } };
};

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
 * Options for Binding resolution. `deriveContext` is not among them: this
 * service owns the Workflow Stage projection, so a caller-supplied hook could
 * only be one that is never run.
 */
export type ResolveBindingAssetsOptions = Omit<ResolveAssetsOptions, "deriveContext">;

/** Resolve Binding Assets through the generic filesystem resolution pipeline. */
export const resolveBindingAssets = async (
  requestInput: unknown,
  options: ResolveBindingAssetsOptions,
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
    deriveContext: workflowStageContext(catalog),
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
