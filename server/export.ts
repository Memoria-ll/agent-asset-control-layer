import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Core } from './core.ts';
import {
  assetSchema,
  bundlePathSchema,
  contextSchema,
  idSchema,
  inputOf,
  DomainError,
  type Asset,
  type Config,
  type Context,
  type Project,
} from './domain.ts';
import { scopeMatches } from './resolver.ts';
import { builtinSkills } from './builtin-skills.ts';

export const exportInputSchema = z
  .object({
    assetIds: z
      .array(idSchema)
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, 'Select each asset once'),
    mode: z.enum(['standalone', 'connected']),
    runtime: z.enum(['codex', 'claude', 'cursor', 'generic']),
    context: contextSchema.optional(),
  })
  .strict();
export type ExportInput = z.infer<typeof exportInputSchema>;
export type ExportFile = { path: string; content: string };
export type ExportLimitation = {
  code: string;
  assetId?: string;
  path?: string;
  severity: 'warning' | 'blocking';
  message: string;
};
export type ExportMapping = {
  id: string;
  revision: number;
  type: Asset['type'];
  sha256: string;
  entry: string;
  canonical: string;
  files: string[];
};
export type ExportBundle = {
  manifest: {
    schemaVersion: 1;
    bundleId: string;
    mode: ExportInput['mode'];
    runtime: ExportInput['runtime'];
    selectedAssetIds: string[];
    settingsVersion: number;
    assets: ExportMapping[];
    files: { path: string; sha256: string; bytes: number }[];
  };
  assets: Asset[];
  relations: { sourceId: string; targetId: string; kind: string; detail?: unknown }[];
  config: Config;
  projects: Project[];
  context: Context;
  files: ExportFile[];
  outputSpecifications: {
    version: 1;
    requiresCore: boolean;
    dependencyClosure: string;
    modelPolicy: string;
    entrypoints: { id: string; path: string }[];
    installation: string[];
    verification: string[];
    contractFiles: string[];
  };
  limitations: ExportLimitation[];
  ready: boolean;
};
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const liveCoreReference =
  /\baacl_(?:session|context|asset|skill|run|workflow|export|proposal|config|review|journal|snapshot|onboarding)_[a-z_]+\b|(?:https?:\/\/[^\s)]+\/mcp\b)|aacl:\/\//i;
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(immutable);
    Object.freeze(value);
  }
  return value;
}
const slug = (id: string) =>
  `a-${id
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 45)}-${hash(id).slice(0, 10)}`;
const localLink = (from: string, to: string) =>
  path.posix.relative(path.posix.dirname(from), to).split('/').map(encodeURIComponent).join('/');
const skillRoot = (runtime: ExportInput['runtime']) =>
  ({
    codex: '.agents/skills',
    claude: '.claude/skills',
    cursor: '.cursor/skills',
    generic: 'skills',
  })[runtime];
const entryPath = (asset: Asset, runtime: ExportInput['runtime']) =>
  ['skill', 'workflow'].includes(asset.type)
    ? `${skillRoot(runtime)}/${slug(asset.id)}/SKILL.md`
    : `aacl-export/assets/${slug(asset.id)}/ASSET.md`;
const frontmatter = (asset: Asset) =>
  `---\nname: ${slug(asset.id)}\ndescription: ${JSON.stringify(asset.description || asset.name)}\n---\n\n`;
const ownBody = (asset: Asset) =>
  asset.type === 'skill'
    ? asset.content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
    : asset.content;
const decodeLink = (href: string) => {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
};

// Reference uses (full, collapsed, or shortcut) share a definition. Map the definition's
// destination once, preserving its label, optional angle brackets, fragment, and title.
function mapMarkdownDestinations(body: string, map: (href: string) => string): string {
  const replace = (
    _whole: string,
    prefix: string,
    angled: string | undefined,
    bare: string | undefined,
  ) => prefix + (angled === undefined ? map(bare!) : `<${map(angled)}>`);
  return body
    .replace(/(\]\([ \t]*)(?:<([^<>\r\n]*)>|((?:\\.|[^\s()]+|\([^()]*\))+))/g, replace)
    .replace(
      /^([ \t]*(?:(?:>[ \t]*)|(?:[-+*]|\d{1,9}[.)])[ \t]+)*\[(?:\\.|[^\]\\])+\]:[ \t]*(?:\r?\n[ \t]*(?:>[ \t]*)*)?)(?:<([^<>\r\n]+)>|((?:\\[^\r\n]|[^\s])+))/gm,
      replace,
    );
}

// This helper is generated as a file, never executed or written by exportBundle.
// The host runtime supplies subagent tools; this pure JSON protocol checks their reported stage results.
const workflowHelper = String.raw`import fs from 'node:fs';
const fail = (message) => { throw new Error(message); };
export function transition(definition, request) {
  if (request.action === 'start') {
    if (!definition.stages.some((s) => s.id === definition.entryStage)) fail('Invalid entry stage');
    return { version: 1, stage: definition.entryStage, status: 'active', artifacts: {}, evidence: {}, events: [] };
  }
  const state = structuredClone(request.state);
  if (!state || state.status !== 'active') fail('An active saved workflow state is required');
  if (request.expectedVersion !== state.version) fail('Workflow state version changed');
  const stage = definition.stages.find((s) => s.id === state.stage);
  if (!stage) fail('Unknown stage');
  const supplied = request.artifacts ?? {};
  if (Object.values(supplied).some((v) => typeof v !== 'string' || !v.trim())) fail('Artifact references must be nonempty strings');
  const artifacts = { ...state.artifacts, ...supplied };
  const criteria = request.criteria ?? {};
  const completing = request.kind === 'complete';
  const returning = ['return', 'retry', 'reject'].includes(request.kind);
  const edge = stage.transitions.find((e) => e.to === request.to && e.kind === request.kind);
  if (request.kind === 'cancel') {
    state.status = 'cancelled';
  } else {
    for (const [name, value] of Object.entries(supplied))
      if (Object.hasOwn(state.artifacts, name) && state.artifacts[name] !== value)
        fail('Return to the producing stage before changing an earlier artifact: ' + name);
    if (completing && !(stage.canComplete ?? stage.transitions.length === 0)) fail('Stage cannot complete');
    if (!completing && !edge) fail('Transition is not defined');
    if (returning && !request.reason?.trim()) fail('Return/retry/reject requires a reason');
    if (completing || request.kind === 'advance') {
      for (const name of stage.expectedOutput ?? []) if (!artifacts[name]?.trim()) fail('Missing output: ' + name);
      for (const name of [...stage.completionCriteria, ...(completing ? definition.completionCriteria : [])])
        if (typeof criteria[name] !== 'string' || !criteria[name].trim()) fail('Missing completion evidence: ' + name);
    }
    for (const name of edge?.requiredArtifacts ?? []) if (!artifacts[name]?.trim()) fail('Missing transition artifact: ' + name);
    if (returning) {
      const invalidated = new Set();
      const invalidate = (id) => {
        if (invalidated.has(id)) return;
        invalidated.add(id);
        const target = definition.stages.find((s) => s.id === id);
        for (const output of target.expectedOutput ?? []) delete artifacts[output];
        for (const next of target.transitions) if (next.kind === 'advance') invalidate(next.to);
      };
      invalidate(edge.to);
      for (const id of invalidated) delete state.evidence[id];
    } else {
      state.evidence[stage.id] = { criteria, artifacts: structuredClone(artifacts) };
    }
    state.artifacts = artifacts;
    if (completing) state.status = 'completed';
    else state.stage = edge.to;
  }
  state.version++;
  state.events.push({ from: stage.id, to: state.stage, kind: request.kind,
    reason: request.reason ?? '', criteria, artifacts: supplied });
  return state;
}
try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  process.stdout.write(JSON.stringify(transition(input.definition, input.request)) + '\n');
} catch (error) {
  process.stderr.write(String(error.message) + '\n');
  process.exitCode = 1;
}
`;

/** Coherent read-only export. Exactly one Core read; no Store calls, discovery, persistence, or filesystem writes. */
export function exportBundle(core: Pick<Core, 'state'>, input: unknown): ExportBundle {
  const req = exportInputSchema.parse(input);
  const snapshot = structuredClone(core.state());
  const { state } = snapshot;
  const catalog = new Map(snapshot.assets.map((asset) => [asset.id, asset]));
  for (const builtin of builtinSkills) {
    const existing = catalog.get(builtin.id);
    if (existing && json(existing) !== json(builtin))
      throw new DomainError(
        'EXPORT_BUILTIN_CONFLICT',
        `Reserved built-in ID conflicts with a stored asset: ${builtin.id}`,
        409,
      );
    catalog.set(builtin.id, structuredClone(builtin));
  }
  const context: Context = { ...req.context };
  if (context.project && !state.projects.some((p) => p.id === context.project))
    throw new DomainError('EXPORT_PROJECT', `Project is not registered: ${context.project}`);
  const selected = new Set<string>();
  const queue = [...req.assetIds];
  const relations: ExportBundle['relations'] = [];
  const limitations: ExportLimitation[] = [];
  const issue = (value: ExportLimitation) => {
    if (!limitations.some((v) => json(v) === json(value))) limitations.push(value);
  };
  const add = (sourceId: string, targetId: string, kind: string, detail?: unknown) => {
    if (!catalog.has(targetId))
      throw new DomainError(
        'EXPORT_REFERENCE',
        `Missing ${kind} target ${targetId} from ${sourceId}`,
        409,
      );
    if (
      !relations.some(
        (r) =>
          r.sourceId === sourceId &&
          r.targetId === targetId &&
          r.kind === kind &&
          json(r.detail) === json(detail),
      )
    )
      relations.push({ sourceId, targetId, kind, ...(detail === undefined ? {} : { detail }) });
    if (!selected.has(targetId)) queue.push(targetId);
  };
  const contexts: Context[] = [];
  const workflowContext = (asset: Asset) => {
    for (const stage of asset.workflow?.stages ?? []) {
      const binding =
        state.config.bindings.find((b) => b.role === stage.role && b.workflow === asset.id) ??
        state.config.bindings.find((b) => b.role === stage.role && !b.workflow);
      const ctx = {
        ...context,
        project: context.project ?? asset.projectId,
        workflow: asset.id,
        stage: stage.id,
        role: stage.role,
        taskType: stage.taskType,
        model: context.model ?? stage.model ?? binding?.model,
        runtime:
          context.runtime ??
          stage.runtime ??
          binding?.runtime ??
          (req.runtime === 'generic' ? undefined : req.runtime),
      };
      const model = state.config.models.find((m) => m.id === ctx.model);
      contexts.push({ ...ctx, provider: context.provider ?? model?.provider });
    }
  };
  let cursor = 0;
  const drain = () => {
    while (cursor < queue.length) {
      const id = queue[cursor++];
      if (selected.has(id)) continue;
      if (selected.size >= 1000)
        throw new DomainError('EXPORT_LIMIT', 'An export closure may contain at most 1000 assets.');
      const asset = catalog.get(id);
      if (!asset) throw new DomainError('EXPORT_ASSET', `Asset not found: ${id}`, 404);
      assetSchema.parse(inputOf(asset));
      if (!Number.isInteger(asset.revision) || asset.revision < 1)
        throw new DomainError('EXPORT_REVISION', `Invalid revision: ${id}`);
      selected.add(id);
      asset.dependencies.forEach((target) => add(id, target, 'dependency'));
      asset.conflicts.forEach((target) => add(id, target, 'conflict'));
      asset.relations?.forEach((relation) => add(id, relation.target, relation.kind, relation));
      // Explicit document references are part of the portable closure without inferring executable relations.
      for (const [relative, body] of [['', asset.content], ...Object.entries(asset.files ?? {})]) {
        for (const match of body.matchAll(
          /aacl:\/\/assets\/([a-zA-Z0-9][a-zA-Z0-9._-]*)(?:@(\d+))?/g,
        )) {
          const target = catalog.get(match[1]);
          if (match[2] && target?.revision !== Number(match[2]))
            throw new DomainError(
              'EXPORT_REFERENCE_REVISION',
              `Referenced revision is not current in this snapshot: ${match[1]}@${match[2]}`,
              409,
            );
          add(id, match[1], 'document-reference');
        }
        if (!relative || /\.(md|mdx|txt)$/i.test(relative))
          mapMarkdownDestinations(body, (destination) => {
            const href = decodeLink(destination.split('#')[0]);
            if (!href || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(href)) return destination;
            for (const candidate of catalog.values())
              if (
                candidate.id !== id &&
                candidate.sources?.some((target) =>
                  asset.sources?.some((origin) => {
                    if (target.host !== origin.host) return false;
                    const api = /^[A-Za-z]:|^\\\\/.test(origin.path) ? path.win32 : path.posix;
                    return (
                      api.normalize(target.path) ===
                      api.resolve(
                        api.dirname(origin.path),
                        relative ? path.posix.dirname(relative) : '.',
                        href,
                      )
                    );
                  }),
                )
              )
                add(id, candidate.id, 'document-reference');
            return destination;
          });
      }
      if (asset.skill?.role) add(id, asset.skill.role, 'role-constraint');
      if (asset.skill?.taskType) add(id, asset.skill.taskType, 'task-type-constraint');
      for (const stage of asset.workflow?.stages ?? []) {
        add(id, stage.role, 'stage-role', { stage: stage.id });
        if (stage.taskType) add(id, stage.taskType, 'stage-task-type', { stage: stage.id });
        stage.requiredAssets.forEach((target) =>
          add(id, target, 'stage-asset', { stage: stage.id }),
        );
        stage.requiredCapabilities.forEach((target) =>
          add(id, target, 'stage-capability', { stage: stage.id }),
        );
      }
      workflowContext(asset);
      if (req.assetIds.includes(id) && ['skill', 'role'].includes(asset.type)) {
        const binding =
          asset.type === 'role'
            ? state.config.bindings.find((b) => b.role === id && !b.workflow)
            : undefined;
        contexts.push({
          ...context,
          project: context.project ?? asset.projectId,
          role: asset.type === 'role' ? id : context.role,
          model: context.model ?? binding?.model,
          runtime:
            context.runtime ??
            binding?.runtime ??
            (req.runtime === 'generic' ? undefined : req.runtime),
        });
      }
      for (const project of state.projects.filter(
        (p) => p.id === context.project || p.id === asset.projectId,
      )) {
        const override = project.overrides[id];
        if (override) add(id, override, 'project-override', { projectId: project.id });
      }
    }
  };
  drain();
  // Include applicable automatic instructions and scoped skill candidates, but do not activate them.
  // A missing model means model-specific conditions are carried along for later evaluation, not assumed true.
  for (let previous = -1; previous !== selected.size;) {
    previous = selected.size;
    for (const ctx of contexts) {
      const project = state.projects.find((p) => p.id === ctx.project);
      for (const asset of snapshot.assets) {
        if (
          selected.has(asset.id) ||
          !['rule', 'policy', 'knowledge', 'template', 'skill'].includes(asset.type)
        )
          continue;
        const scope = { ...asset.scope, ...project?.bindings[asset.id] };
        if ((!asset.enabled || project?.disabled.includes(asset.id)) && !asset.mandatory) continue;
        if (asset.projectId && asset.projectId !== ctx.project) continue;
        if (asset.activation !== 'auto' && !Object.keys(scope).length) continue;
        const comparable = { ...scope };
        if (!ctx.model) delete comparable.model;
        if (!ctx.provider) delete comparable.provider;
        if (scopeMatches(comparable, ctx)) {
          queue.push(asset.id);
          if (!ctx.model && scope.model)
            issue({
              code: 'MODEL_CONDITION_UNEVALUATED',
              assetId: asset.id,
              severity: 'warning',
              message:
                'Model-specific content is bundled but must remain inactive until the actual runtime model is known and matches its scope.',
            });
        }
      }
    }
    drain();
  }
  const assets = [...selected].sort().map((id) => catalog.get(id)!);
  const workflowIds = new Set(assets.filter((a) => a.workflow).map((a) => a.id));
  const roleIds = new Set(assets.filter((a) => a.type === 'role').map((a) => a.id));
  const bindings = state.config.bindings.filter(
    (b) => roleIds.has(b.role) && (!b.workflow || workflowIds.has(b.workflow)),
  );
  const stages = assets.flatMap((a) => a.workflow?.stages ?? []);
  const modelIds = new Set(
    [
      context.model,
      ...bindings.map((b) => b.model),
      ...stages.flatMap((s) => [s.model, s.modelConstraint?.model]),
      ...assets.flatMap((a) => a.scope.model ?? []),
    ].filter(Boolean),
  );
  const models = state.config.models.filter((m) => modelIds.has(m.id));
  const runtimeIds = new Set(
    [
      context.runtime,
      req.runtime,
      ...bindings.map((b) => b.runtime),
      ...stages.map((s) => s.runtime),
      ...assets.flatMap((a) => a.scope.runtime ?? []),
    ].filter(Boolean),
  );
  const runtimes = state.config.runtimes
    .filter((r) => runtimeIds.has(r.id))
    .map(({ endpoint, ...runtime }) => {
      // Credentials may occur in any URL component, including an opaque path. Never copy
      // source connection locations into a portable artifact or echo them in diagnostics.
      if (endpoint !== undefined)
        issue({
          code: 'RUNTIME_ENDPOINT_OMITTED',
          severity: req.mode === 'connected' ? 'blocking' : 'warning',
          message:
            req.mode === 'connected'
              ? 'Source runtime endpoints were omitted because they may contain credentials. Configure and verify destination connections separately before using this connected bundle.'
              : 'Source runtime endpoints were omitted because they may contain credentials and are unnecessary for standalone use.',
        });
      return runtime;
    });
  const providerIds = new Set(
    [context.provider, ...models.map((m) => m.provider), ...runtimes.map((r) => r.provider)].filter(
      Boolean,
    ),
  );
  const config: Config = {
    providers: state.config.providers.filter((p) => providerIds.has(p.id)),
    accounts: state.config.accounts.filter((a) => models.some((m) => m.account === a.id)),
    models,
    runtimes,
    bindings,
  };
  const projects = state.projects
    .filter((p) => p.id === context.project || assets.some((a) => a.projectId === p.id))
    .map((p) => ({
      ...p,
      disabled: p.disabled.filter((id) => selected.has(id)),
      overrides: Object.fromEntries(Object.entries(p.overrides).filter(([id]) => selected.has(id))),
      bindings: Object.fromEntries(Object.entries(p.bindings).filter(([id]) => selected.has(id))),
    }));
  const mapping: ExportMapping[] = assets.map((a) => ({
    id: a.id,
    revision: a.revision,
    type: a.type,
    sha256: hash(json(a)),
    entry: entryPath(a, req.runtime),
    canonical: `aacl-export/catalog/${slug(a.id)}.json`,
    files: [],
  }));
  const byId = new Map(mapping.map((m) => [m.id, m]));
  const files: ExportFile[] = [];
  const filePaths = new Set<string>();
  let byteCount = 0;
  const emit = (file: string, content: string) => {
    bundlePathSchema.parse(file);
    const lower = file.toLowerCase();
    if (
      [...filePaths].some(
        (existing) =>
          existing === lower ||
          existing.startsWith(lower + '/') ||
          lower.startsWith(existing + '/'),
      )
    )
      throw new DomainError('EXPORT_PATH_CONFLICT', `Conflicting output path: ${file}`, 409);
    byteCount += Buffer.byteLength(content);
    if (byteCount > 32 * 1024 * 1024 || files.length >= 10000)
      throw new DomainError(
        'EXPORT_LIMIT',
        'Export exceeds 32 MiB or 10000 files. Select a smaller asset set.',
      );
    filePaths.add(file.toLowerCase());
    files.push({ path: file, content });
  };
  const rewrite = (content: string, source: Asset, output: string, relativeSource = '') => {
    let rewritten = content.replace(
      /aacl:\/\/assets\/([a-zA-Z0-9][a-zA-Z0-9._-]*)(?:@(\d+))?/g,
      (original, id: string, revision: string | undefined) => {
        const target = byId.get(id);
        if (!target || (revision && Number(revision) !== target.revision)) {
          issue({
            code: 'UNRESOLVED_LOCAL_REFERENCE',
            severity: 'blocking',
            assetId: source.id,
            path: output,
            message: `Reference ${original} is not in this pinned closure; request the referenced revision or correct the source before standalone use.`,
          });
          return original;
        }
        return localLink(output, target.entry);
      },
    );
    rewritten = mapMarkdownDestinations(rewritten, (href) => {
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(href)) return href;
      const [encodedPath, fragment] = href.split('#');
      const targetPath = decodeLink(encodedPath);
      const localSource = path.posix.normalize(
        path.posix.join(path.posix.dirname(relativeSource || 'SKILL.md'), targetPath),
      );
      if (Object.hasOwn(source.files ?? {}, localSource)) return href;
      const matched = assets.filter(
        (candidate) =>
          candidate.id !== source.id &&
          candidate.sources?.some((target) =>
            source.sources?.some((origin) => {
              if (target.host !== origin.host) return false;
              const api = /^[A-Za-z]:|^\\\\/.test(origin.path) ? path.win32 : path.posix;
              return (
                api.normalize(target.path) ===
                api.resolve(
                  api.dirname(origin.path),
                  relativeSource ? path.posix.dirname(relativeSource) : '.',
                  targetPath,
                )
              );
            }),
          ),
      );
      if (matched.length === 1)
        return `${localLink(output, byId.get(matched[0].id)!.entry)}${fragment ? '#' + fragment : ''}`;
      if (
        !filePaths.has(
          path.posix
            .normalize(path.posix.join(path.posix.dirname(output), targetPath))
            .toLowerCase(),
        )
      )
        issue({
          code: 'UNRESOLVED_LOCAL_REFERENCE',
          severity: 'blocking',
          assetId: source.id,
          path: output,
          message: `Local reference ${href} could not be mapped to a bundled file; verify or convert it before standalone use.`,
        });
      return href;
    });
    if (req.mode === 'standalone' && liveCoreReference.test(rewritten))
      issue({
        code: 'LIVE_CORE_REFERENCE',
        assetId: source.id,
        path: output,
        severity: 'blocking',
        message:
          'Source instructions contain a live AACL reference that needs semantic conversion. This standalone export is not ready for independent use.',
      });
    return rewritten;
  };
  // Reserve paths before rewriting cross-asset links, then emit without relying on filesystem state.
  const plannedPaths = new Set(
    mapping.flatMap((m) => [
      m.entry,
      m.canonical,
      ...Object.keys(catalog.get(m.id)!.files ?? {}).map((relative) =>
        path.posix.join(path.posix.dirname(m.entry), relative),
      ),
    ]),
  );
  const referenceSection = (asset: Asset, entry: string) => {
    const refs = relations.filter((r) => r.sourceId === asset.id);
    return refs.length
      ? '\n\n## Local asset references\n\n' +
          refs
            .map(
              (r) =>
                `- ${r.kind}: [${r.targetId}@${byId.get(r.targetId)!.revision}](${localLink(entry, byId.get(r.targetId)!.entry)})${r.detail ? ` — conditions/provenance: ${JSON.stringify(r.detail)}` : ''}`,
            )
            .join('\n') +
          '\n'
      : '';
  };
  for (const asset of assets) {
    const map = byId.get(asset.id)!;
    const header = `<!-- Generated from AACL ${asset.type} ${asset.id}@${asset.revision}; source type remains ${asset.type}. -->\n\n`;
    if (!asset.enabled)
      issue({
        code: 'DISABLED_ASSET',
        assetId: asset.id,
        severity: 'warning',
        message:
          'This asset is bundled for closure but remains disabled; do not activate it merely because its file is present.',
      });
    if (
      asset.compatibility === 'unsupported' ||
      (asset.compatibility === 'claude-only' && req.runtime !== 'claude') ||
      (asset.compatibility === 'codex-only' && req.runtime !== 'codex')
    )
      issue({
        code: 'RUNTIME_COMPATIBILITY',
        assetId: asset.id,
        severity: 'blocking',
        message: `Source compatibility ${asset.compatibility} is not satisfied by destination ${req.runtime}.`,
      });
    if (asset.capability)
      issue({
        code: 'CAPABILITY_REQUIRES_SETUP',
        assetId: asset.id,
        severity: 'blocking',
        message: `Capability ${asset.id} needs provider ${asset.capability.provider}, tools ${asset.capability.tools.join(', ')}, and destination permission/connection verification. Source connected/allowed flags are not portable credentials or guarantees.`,
      });
    for (const requirement of asset.workflow?.requiredEnforcement ?? [])
      issue({
        code: 'ENFORCEMENT_UNSUPPORTED',
        assetId: asset.id,
        severity: 'blocking',
        message: `Required ${requirement} enforcement cannot be supplied by generated instructions. Verify a destination enforcement mechanism before running this workflow.`,
      });
    for (const stage of asset.workflow?.stages ?? []) {
      if (stage.modelConstraint && Object.keys(stage.modelConstraint).length)
        issue({
          code: 'MODEL_CONSTRAINT_REQUIRES_VERIFICATION',
          assetId: asset.id,
          severity: 'blocking',
          message: `Stage ${stage.id} has required model conditions ${JSON.stringify(stage.modelConstraint)}. The destination must verify actual child model identity; an instruction or parent model name is not evidence.`,
        });
      const binding =
        bindings.find((b) => b.role === stage.role && b.workflow === asset.id) ??
        bindings.find((b) => b.role === stage.role && !b.workflow);
      const selectedModel = context.model ?? stage.model ?? binding?.model;
      const selectedRuntime = context.runtime ?? stage.runtime ?? binding?.runtime;
      if (selectedModel)
        issue({
          code: 'MODEL_SELECTION_UNVERIFIED',
          assetId: asset.id,
          severity: 'warning',
          message: `Stage ${stage.id} requests model ${selectedModel}. Preserve it and verify destination selection support; never substitute silently.`,
        });
      if (selectedRuntime && req.runtime !== 'generic' && selectedRuntime !== req.runtime)
        issue({
          code: 'RUNTIME_SELECTION_MISMATCH',
          assetId: asset.id,
          severity: 'blocking',
          message: `Stage ${stage.id} selects source runtime ${selectedRuntime}; the destination is ${req.runtime}. An explicit conversion decision is required.`,
        });
    }
    if (asset.workflow) {
      const definitionPath = `aacl-export/workflows/${slug(asset.id)}.json`;
      const localCatalog = localLink(map.entry, 'aacl-export/settings.json');
      let body: string;
      if (req.mode === 'connected')
        body = `# Connected Workflow: ${asset.name}\n\nThis output requires a running AACL Core and a configured MCP connection.\nRead aacl_asset_get for ${asset.id} and verify revision ${asset.revision} before launching; re-export if it differs.\nCall aacl_session_start with workflowId=${asset.id} and the user's instruction, then aacl_context_handoff.\nThe stored local definition is an inspection copy, not an independent run.\n`;
      else
        body =
          `# Workflow: ${asset.name}\n\nThis generated orchestration Skill implements a canonical Workflow. It delegates work; it does not reclassify the source as a Skill.\nUse the target runtime's subagent tools. Do not call a live Core. If subagent delegation or an explicit constraint cannot be supported, stop the affected execution and report it.\n\n## Begin the requested work\n\nRead [the local Workflow definition](${localLink(map.entry, definitionPath)}), [settings and project conditions](${localCatalog}), and [limitations](${localLink(map.entry, 'aacl-export/limitations.json')}).\nAccept the user's concrete task and explicit working directory. Development permission is ${asset.workflow.developmentCapable ? 'available within this user-requested Workflow' : 'not granted; perform advisory work only'}. Check required enforcement/capabilities before acting.\nUse [the transition helper](${localLink(map.entry, 'aacl-export/workflow-runtime.mjs')}) with JSON stdin {definition,request:{action:"start"}} to initialize local state. Save its returned JSON only at a user-authorized destination.\n\n## Delegate, wait, inspect, and transition\n\n1. At current stage, read its Role responsibility and applicable Rule bodies. Pass the task, allowed work, current artifact references, expected outputs, completion criteria, and relevant conditions to one subagent for that Role.\n2. Offer relevant Skill descriptions and local entry paths. Let that actor read Skill bodies/helpers only when needed. Required Rules apply before constrained actions; conditional/reference assets are not all automatically activated. Evaluate scope AND across dimensions, OR within a dimension, project overrides, enabled/mandatory flags, and conflicts using the pinned settings. Unresolved ties or required conditions stop the stage.\n3. Model precedence is explicit context selection, matching Workflow/Role binding, Role default, then runtime default. Omit the model argument when unspecified; do not claim the parent's model as the child's. If an explicit model cannot be selected, report it instead of substituting.\n4. Wait for the delegated actor's actual result. Inspect outputs and evidence; a dispatch or prepared context does not count as completion. Use only transitions defined for the current stage.\n5. Submit {definition,request:{state,expectedVersion,kind,to,reason,artifacts,criteria}} to the helper over stdin. The helper prints updated state or fails without changing it. Capture a successful result, then persist it at the same authorized destination. Criteria map each exact criterion to its current evidence; artifacts map output names to concrete paths or references.\n6. On return/retry/reject, explain the issue, invalidate obsolete evidence and outputs, and delegate the target stage again. Re-review changed artifacts. Continue until an allowed completion with current evidence, cancellation, or a reported blocker. Do not execute undefined jumps.\n\n## Stages\n\n` +
          asset.workflow.stages
            .map((stage) => {
              const role = byId.get(stage.role)!;
              const binding =
                bindings.find((b) => b.role === stage.role && b.workflow === asset.id) ??
                bindings.find((b) => b.role === stage.role && !b.workflow);
              const model = context.model ?? stage.model ?? binding?.model;
              return `### ${stage.id}: ${stage.name}\n\nDelegate to [${stage.role}](${localLink(map.entry, role.entry)}). ${model ? `Explicit model: ${JSON.stringify(model)}; verify destination support.` : 'Model unspecified: omit the model argument and use the runtime default.'}\nExpected outputs: ${JSON.stringify(stage.expectedOutput ?? [])}.\nCompletion evidence: ${JSON.stringify(stage.completionCriteria)}.\nMay complete: ${stage.canComplete ?? stage.transitions.length === 0}.\nDefined transitions: ${JSON.stringify(stage.transitions)}.\nRequired assets: ${JSON.stringify(stage.requiredAssets)}; capabilities: ${JSON.stringify(stage.requiredCapabilities)}.\n`;
            })
            .join('\n') +
          `\nWorkflow completion criteria: ${JSON.stringify(asset.workflow.completionCriteria)}.\n`;
      if (req.mode === 'standalone')
        body +=
          `\n## Asset selection and Workflow-specific requirements\n\nRead [asset descriptions and conditions](${localLink(map.entry, 'aacl-export/asset-index.json')}) to find applicable Rules and candidate Skills without opening every Skill body. Read a selected Skill's entry and helper files only when needed.\n\nThe following source guidance belongs to this same Workflow. Preserve its additional requirements within the stages above; do not start a second orchestration described by the same source. If source guidance conflicts with the stage definition, resolve that conflict before execution.\n\n` +
          rewrite(ownBody(asset), asset, map.entry) +
          '\n';
      emit(map.entry, frontmatter(asset) + header + body + referenceSection(asset, map.entry));
      emit(definitionPath, json(asset.workflow));
      map.files.push(definitionPath);
    } else {
      const contract = asset.role ?? asset.skill ?? asset.taskType ?? asset.capability;
      const body = rewrite(ownBody(asset), asset, map.entry);
      emit(
        map.entry,
        (asset.type === 'skill' ? frontmatter(asset) : `# ${asset.name}\n\n`) +
          header +
          `Applicability: ${JSON.stringify(asset.scope)}. Enabled: ${asset.enabled}. Mandatory: ${asset.mandatory}.\n\n` +
          body +
          (contract ? `\n\nDeclared contract:\n\n${'```json'}\n${json(contract)}${'```'}\n` : '') +
          referenceSection(asset, map.entry),
      );
    }
    emit(map.canonical, json(asset));
    for (const [relative, content] of Object.entries(asset.files ?? {})) {
      const file = path.posix.join(path.posix.dirname(map.entry), relative);
      if (file.toLowerCase() === map.entry.toLowerCase())
        throw new DomainError('EXPORT_PATH_CONFLICT', `Helper overwrites entry: ${file}`, 409);
      if (
        req.mode === 'standalone' &&
        !/\.(md|mdx|txt)$/i.test(relative) &&
        liveCoreReference.test(content)
      )
        issue({
          code: 'LIVE_CORE_REFERENCE',
          assetId: asset.id,
          path: file,
          severity: 'blocking',
          message:
            'A source-provided helper contains a live Core dependency. Its code is preserved unchanged; convert and verify it before standalone use.',
        });
      emit(
        file,
        /\.(md|mdx|txt)$/i.test(relative) ? rewrite(content, asset, file, relative) : content,
      );
      map.files.push(file);
    }
    for (const modelId of [
      context.model,
      ...bindings.filter((b) => b.role === asset.id || b.workflow === asset.id).map((b) => b.model),
    ].filter(Boolean))
      if (!models.some((m) => m.id === modelId))
        issue({
          code: 'MODEL_SELECTION_UNVERIFIED',
          assetId: asset.id,
          severity: 'warning',
          message: `Explicit model ${modelId} is preserved but its destination availability must be checked. Do not invent a substitute.`,
        });
  }
  // Forward local links are valid even when their target was emitted later.
  const unresolved = limitations.filter((l) => l.code === 'UNRESOLVED_LOCAL_REFERENCE' && l.path);
  for (const limitation of unresolved) {
    const match = limitation.message.match(/^Local reference (\S+) could not/);
    if (
      match &&
      plannedPaths.has(
        path.posix.normalize(
          path.posix.join(path.posix.dirname(limitation.path!), decodeLink(match[1].split('#')[0])),
        ),
      )
    )
      limitations.splice(limitations.indexOf(limitation), 1);
  }
  if (req.mode === 'standalone' && assets.some((a) => a.workflow)) {
    emit('aacl-export/workflow-runtime.mjs', workflowHelper);
    issue({
      code: 'RUNTIME_DELEGATION_REQUIRED',
      severity: 'warning',
      message:
        'The destination must provide subagent delegation and waiting. The local helper validates state transitions but does not launch models or enforce permissions.',
    });
  }
  const contractAsset = builtinSkills.find((a) => a.id === 'aacl-asset-export')!;
  const contractFiles = ['output-contract.md', 'runtime-layouts.md'].map(
    (name) => `aacl-export/specifications/${name}`,
  );
  for (const file of contractFiles)
    emit(file, contractAsset.files![`references/${path.posix.basename(file)}`]);
  emit(
    'aacl-export/settings.json',
    json({ version: state.settingsVersion ?? 0, context, config, projects }),
  );
  emit(
    'aacl-export/asset-index.json',
    json(
      assets.map((a) => ({
        id: a.id,
        revision: a.revision,
        name: a.name,
        description: a.description,
        type: a.type,
        entry: byId.get(a.id)!.entry,
        scope: a.scope,
        activation: a.activation,
        enabled: a.enabled,
        mandatory: a.mandatory,
        priority: a.priority,
        projectId: a.projectId,
        dependencies: a.dependencies,
        conflicts: a.conflicts,
        relations: a.relations ?? [],
      })),
    ),
  );
  emit('aacl-export/relations.json', json(relations));
  emit('aacl-export/limitations.json', json(limitations));
  const outputSpecifications: ExportBundle['outputSpecifications'] = {
    version: 1,
    requiresCore: req.mode === 'connected',
    dependencyClosure:
      'Selected assets; every dependency/conflict/required/conditional/reference target; Workflow stage Roles/task types/assets/capabilities; applicable automatic instructions and scoped Skill candidates; relevant project overrides. Inclusion preserves conditions and does not mean activation.',
    modelPolicy:
      'Explicit model selections are preserved. Unspecified means omit the model argument and use the runtime default; never invent a model or record the parent as the child.',
    entrypoints: req.assetIds.map((id) => ({ id, path: byId.get(id)!.entry })),
    installation: [
      'Use an explicit user-authorized destination; source roots are provenance only.',
      'Compare existing file contents and present exact diffs before unapproved replacements.',
      'Write the complete returned file set within that destination; preserve unrelated configuration and credentials.',
      'Do not execute source-provided scripts or workflows during installation; the generated validator may be checked with harmless sample input.',
    ],
    verification: [
      'Verify manifest file SHA-256 digests and UTF-8 lengths.',
      'Parse JSON and Skill frontmatter; verify generated ID/revision mappings and local references.',
      'Verify Workflow stage/Role/output/return/completion definitions and validate harmless helper transitions.',
      'Resolve blocking limitations before execution. Standalone operational files must have no live Core dependency.',
    ],
    contractFiles,
  };
  emit(
    'aacl-export/README.md',
    `# AACL ${req.mode} export\n\nSource revisions are pinned in [the manifest](manifest.json).\n${req.mode === 'standalone' ? 'Generated entries use local definitions and assets; the Core is not required for supported output.' : 'Connected entries require an active Core and configured MCP access.'}\nRead [limitations](limitations.json) before use. Exported presence does not activate every asset.\n\n` +
      outputSpecifications.entrypoints
        .map((entry) => `- [${entry.id}](${localLink('aacl-export/README.md', entry.path)})`)
        .join('\n') +
      '\n',
  );
  const manifest: ExportBundle['manifest'] = {
    schemaVersion: 1,
    bundleId: hash(
      json({ req, assets, config, projects, settingsVersion: state.settingsVersion ?? 0 }),
    ),
    mode: req.mode,
    runtime: req.runtime,
    selectedAssetIds: req.assetIds,
    settingsVersion: state.settingsVersion ?? 0,
    assets: mapping,
    files: files.map((file) => ({
      path: file.path,
      sha256: hash(file.content),
      bytes: Buffer.byteLength(file.content),
    })),
  };
  // The manifest intentionally inventories all payload files except itself, avoiding a self-referential hash.
  emit('aacl-export/manifest.json', json(manifest));
  return immutable({
    manifest,
    assets,
    relations,
    config,
    projects,
    context,
    files,
    outputSpecifications,
    limitations,
    ready: !limitations.some((l) => l.severity === 'blocking'),
  });
}
