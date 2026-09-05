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
