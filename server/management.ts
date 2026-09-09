import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Core } from './core.ts';
import {
  configSchema,
  contextSchema,
  idSchema,
  operationSchema,
  scopeSchema,
  DomainError,
  requireValue,
  inputOf,
  type Asset,
  type State,
  type Operation,
  type Resolution,
  type ChangeSet,
} from './domain.ts';
import { assetDiff } from './history.ts';
import { pinnedSkill, runRequirements } from './contracts.ts';
import { discoveryInput, discoveryService, discoverModels } from './discovery.ts';
import { builtinSkills } from './builtin-skills.ts';

const text = z.string().trim().min(1).max(20000);
export const actorSchema = z
  .object({
    kind: z.enum(['user', 'runtime']),
    id: z.string().trim().min(1).max(250),
    userId: z.string().trim().min(1).max(250).optional(),
  })
  .strict()
  .superRefine((actor, ctx) => {
    if (actor.kind === 'runtime' && (!actor.userId || actor.userId === actor.id))
      ctx.addIssue({
        code: 'custom',
        message:
          'Runtime must identify the requesting user separately; a model cannot approve itself.',
      });
    if (actor.kind === 'user' && actor.userId && actor.userId !== actor.id)
      ctx.addIssue({
        code: 'custom',
        message: 'User actor and userId must identify the same user.',
      });
  });
export const authorizationShape = { userRequest: text, actor: actorSchema, reason: text };
export const authorizationSchema = z.object(authorizationShape).strict();
export type Authorization = z.infer<typeof authorizationSchema>;
export function userAttribution(input: Authorization) {
  const auth = authorizationSchema.parse({
    actor: input.actor,
    userRequest: input.userRequest,
    reason: input.reason,
  });
  return {
    actor: auth.actor.kind === 'user' ? auth.actor.id : auth.actor.userId!,
    userRequest: auth.userRequest,
    reason: auth.reason,
  };
}
export const pageShape = {
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().nonnegative().default(0),
  query: z.string().trim().max(500).optional(),
};
const pageSchema = z.object(pageShape);
function page<T>(items: T[], input: unknown = {}) {
  const { limit, offset } = pageSchema.parse(input);
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
    offset,
    limit,
    nextOffset: offset + limit < items.length ? offset + limit : null,
  };
}
const matches = (query: string | undefined, ...values: (string | undefined | null)[]) =>
  !query || values.some((value) => value?.toLowerCase().includes(query.toLowerCase()));
const optionalId = idSchema.optional();
export const assetListShape = {
  ...pageShape,
  type: z.string().optional(),
  projectId: optionalId,
  enabled: z.boolean().optional(),
};
export const runListShape = {
  ...pageShape,
  projectId: optionalId,
  workflowId: optionalId,
  skillId: optionalId,
  status: z.enum(['active', 'completed', 'cancelled']).optional(),
  mode: z.enum(['advisory', 'workflow']).optional(),
};
export const journalListShape = {
  ...pageShape,
  runId: optionalId,
  snapshotId: optionalId,
  projectId: optionalId,
  workflowId: optionalId,
  stage: optionalId,
  kind: z.enum(['friction', 'missing-support', 'defect', 'success', 'improvement']).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
};
export const reviewListShape = {
  ...pageShape,
  projectId: optionalId,
  workflowId: optionalId,
  journalId: optionalId,
  status: z.enum(['awaiting-proposal', 'pending', 'approved', 'rejected']).optional(),
};
export const overlaySchema = z
  .object({
    disabled: z.array(idSchema),
    overrides: z.record(idSchema, idSchema),
    bindings: z.record(idSchema, scopeSchema),
    pathMappings: z
      .array(z.object({ from: z.string().min(1), to: z.string().min(1) }).strict())
      .max(100)
      .optional(),
  })
  .strict();
export const proposalShape = {
  ...authorizationShape,
  operations: z.array(operationSchema).min(1).max(100),
};
export const decisionShape = { ...authorizationShape, decision: z.enum(['approve', 'reject']) };
export const rollbackShape = {
  ...authorizationShape,
  changeSetId: optionalId,
  assetId: optionalId,
  revision: z.number().int().positive().optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
};

export type SettingChangeMeta = {
  reason: string;
  actor: string;
  userRequest?: string;
  expectedVersion?: number;
  restoreOf?: string;
};
export type SettingHistoryEntry = SettingChangeMeta & {
  id: string;
  version: number;
  createdAt: string;
  kind: 'config' | 'overlay';
  targetId?: string;
  before: unknown;
  after: unknown;
};
export type DirectProposal = Authorization & {
  id: string;
  createdAt: string;
  settingsVersion: number;
  status: 'pending' | 'approved' | 'rejected';
  operations: Operation[];
  preview: ReturnType<typeof operationPreview>;
  decision?: Authorization & {
    decision: 'approve' | 'reject';
    decidedAt: string;
    approvedBy?: string;
  };
  changeSetId?: string;
};
type ManagementState = State & {
  settingsHistory?: SettingHistoryEntry[];
  settingsVersion?: number;
  directProposals?: DirectProposal[];
};

// Core invokes this inside its setting mutation transaction. Never save history in a second commit.
export function recordSettingChange(
  state: State,
  entry: SettingChangeMeta & {
    kind: 'config' | 'overlay';
    targetId?: string;
    before: unknown;
    after: unknown;
  },
): SettingHistoryEntry {
  text.parse(entry.reason);
  text.parse(entry.actor);
  if (entry.userRequest !== undefined) text.parse(entry.userRequest);
  const s = state as ManagementState;
  if (entry.expectedVersion !== undefined) {
    z.number().int().nonnegative().parse(entry.expectedVersion);
    if (entry.expectedVersion !== (s.settingsVersion ?? 0))
      throw Object.assign(
        new DomainError(
          'SETTINGS_CONFLICT',
          'Settings changed. Read aacl_config_get and retry with the latest version.',
          409,
        ),
        { details: { latestVersion: s.settingsVersion ?? 0, recoveryTool: 'aacl_config_get' } },
      );
  }
  const history = {
    ...structuredClone(entry),
    id: `setting-${randomUUID()}`,
    version: (s.settingsVersion ?? 0) + 1,
    createdAt: new Date().toISOString(),
  };
  (s.settingsHistory ??= []).unshift(history);
  s.settingsVersion = history.version;
  return history;
}

export function assetMetadata(asset: Asset) {
  return {
    id: asset.id,
    name: asset.name,
    description: asset.description,
    type: asset.type,
    revision: asset.revision,
    projectId: asset.projectId,
    enabled: asset.enabled,
    updatedAt: asset.updatedAt,
  };
}
export function compactResolution(resolution: Resolution) {
  return {
    context: resolution.context,
    valid: resolution.valid,
    errors: resolution.errors,
    content: resolution.content,
    estimatedTokens: resolution.estimatedTokens,
    assets: resolution.assets.map(assetMetadata),
    skillCandidates: resolution.skillCandidates ?? [],
    unevaluated: resolution.unevaluated ?? [],
    entries: resolution.entries.map(({ asset, status, reasons, estimatedTokens }) => ({
      id: asset.id,
      revision: asset.revision,
      status,
      reasons,
      estimatedTokens,
    })),
  };
}
function operationPreview(
  state: State,
  assets: Asset[],
  operations: Operation[],
  validated: ChangeSet,
) {
  const ids = operations.map((op) => (op.op === 'upsert' ? op.asset.id : op.id));
  if (new Set(ids).size !== ids.length)
    throw new DomainError(
      'DUPLICATE_OPERATION',
      'An asset may be changed only once in a proposal.',
    );
  const changes = operations.map((op) => {
    const id = op.op === 'upsert' ? op.asset.id : op.id;
    const before = assets.find((asset) => asset.id === id) ?? null;
    if ((before?.revision ?? 0) !== op.expectedRevision)
      throw new DomainError(
        'REVISION_CONFLICT',
        `${id} changed. Read aacl_asset_get before proposing.`,
        409,
      );
    const after = requireValue(
      validated.changes.find((c) => c.id === id),
      'Validated change missing',
    ).after;
    return { before, after, diff: assetDiff(before, after) };
  });
  const proposed = assets
    .filter((a) => !ids.includes(a.id))
    .concat(changes.flatMap((c) => (c.after ? [c.after] : [])));
  const affectedWorkflows = proposed.filter(
    (a) =>
      a.workflow &&
      (ids.includes(a.id) ||
        a.workflow.stages.some((s) =>
          [s.role, s.taskType, ...s.requiredAssets, ...s.requiredCapabilities].some(
            (id) => id && ids.includes(id),
          ),
        )),
  );
  return {
    changes,
    impact: {
      affectedAssets: assets
        .filter(
          (a) =>
            a.dependencies.some((id) => ids.includes(id)) ||
            a.conflicts.some((id) => ids.includes(id)) ||
            a.relations?.some((r) => ids.includes(r.target)),
        )
        .map(assetMetadata),
      workflows: affectedWorkflows.map(assetMetadata),
      bindings: state.config.bindings.filter(
        (b) => ids.includes(b.role) || (!!b.workflow && ids.includes(b.workflow)),
      ),
      missingModelBindings: affectedWorkflows.flatMap((a) =>
        a
          .workflow!.stages.filter(
            (s) =>
              !state.config.bindings.some(
                (b) => b.role === s.role && (!b.workflow || b.workflow === a.id),
              ),
          )
          .map((s) => ({ workflowId: a.id, stage: s.id, role: s.role })),
      ),
      existingRunsKeepSnapshots: state.runs
        .filter((r) => r.workflow && ids.includes(r.workflow.id))
        .map((r) => r.id),
    },
  };
}

export class Management {
  readonly discoverModels;
  constructor(
    readonly core: Core,
    discovery = discoverModels,
  ) {
    this.discoverModels = discoveryService(discovery);
  }
  projects(input: unknown = {}) {
    const req = pageSchema.parse(input);
    return page(
      this.core.state().state.projects.filter((p) => matches(req.query, p.id, p.name, p.root)),
      req,
    );
  }
  models(input: unknown = {}) {
    const req = z.object({ ...pageShape, provider: optionalId }).parse(input);
    return page(
      this.core
        .state()
        .state.config.models.filter(
          (m) => (!req.provider || m.provider === req.provider) && matches(req.query, m.id, m.name),
        ),
      req,
    );
  }
  config() {
    const { state } = this.core.state();
    return { config: state.config, settingsVersion: state.settingsVersion ?? 0 };
  }
  discover(input: unknown) {
    return this.discoverModels(discoveryInput.parse(input));
  }
  initProject(input: unknown) {
    const req = z
      .object({ ...authorizationShape, root: text, name: text })
      .strict()
      .parse(input);
    userAttribution(req);
    return this.core.initProject({ root: req.root, name: req.name });
  }
  updateConfig(input: unknown) {
    const { config, expectedVersion, ...auth } = z
      .object({
        ...authorizationShape,
        config: configSchema,
        expectedVersion: z.number().int().nonnegative(),
      })
      .strict()
      .parse(input);
    this.core.updateConfig(config, { ...userAttribution(auth), expectedVersion });
    return this.config();
  }
  updateOverlay(projectId: string, input: unknown) {
    const { overlay, expectedVersion, ...auth } = z
      .object({
        ...authorizationShape,
        overlay: overlaySchema,
        expectedVersion: z.number().int().nonnegative(),
      })
      .strict()
      .parse(input);
    const project = this.core.updateOverlay(projectId, overlay, {
      ...userAttribution(auth),
      expectedVersion,
    });
    return { project, settingsVersion: this.core.state().state.settingsVersion ?? 0 };
  }
  settingsHistory(input: unknown = {}) {
    const req = z
      .object({
        ...pageShape,
        kind: z.enum(['config', 'overlay']).optional(),
        targetId: optionalId,
      })
      .parse(input);
    const state = this.core.state().state as ManagementState;
    return page(
      (state.settingsHistory ?? []).filter(
        (h) =>
          (!req.kind || h.kind === req.kind) &&
          (!req.targetId || h.targetId === req.targetId) &&
          matches(req.query, h.reason, h.actor),
      ),
      req,
    );
  }
  restoreSettings(input: unknown) {
    const { id, side, expectedVersion, ...auth } = z
      .object({
        ...authorizationShape,
        id: idSchema,
        side: z.enum(['before', 'after']).default('before'),
        expectedVersion: z.number().int().nonnegative(),
      })
      .strict()
      .parse(input);
    const state = this.core.state().state as ManagementState;
    const entry = requireValue(
      state.settingsHistory?.find((h) => h.id === id),
      'Setting history not found',
    );
    const meta = { ...userAttribution(auth), expectedVersion, restoreOf: id };
    if (entry.kind === 'config') this.core.updateConfig(entry[side], meta);
    else {
      const saved = z
        .object({
          disabled: z.array(idSchema),
          overrides: z.record(idSchema, idSchema),
          bindings: z.record(idSchema, scopeSchema),
          pathMappings: overlaySchema.shape.pathMappings,
        })
        .parse(entry[side]);
      this.core.updateOverlay(
        requireValue(entry.targetId, 'Overlay project missing'),
        { ...saved, pathMappings: saved.pathMappings ?? [] },
        meta,
      );
    }
    return { settingsVersion: this.core.state().state.settingsVersion ?? 0, restored: id, side };
  }
  assets(input: unknown = {}) {
    const req = z.object(assetListShape).parse(input);
    return page(
      [...this.core.state().assets, ...builtinSkills]
        .filter(
          (a) =>
            (!req.type || a.type === req.type) &&
            (!req.projectId ||
              a.projectId === req.projectId ||
              a.scope.project?.includes(req.projectId)) &&
            (req.enabled === undefined || a.enabled === req.enabled) &&
            matches(req.query, a.id, a.name, a.description),
        )
        .map(assetMetadata),
      req,
    );
  }
  runs(input: unknown = {}) {
    const req = z.object(runListShape).parse(input);
    const { state } = this.core.state();
    return page(
      state.runs
        .filter(
          (r) =>
            (!req.projectId || r.context.project === req.projectId) &&
            (!req.workflowId || r.workflow?.id === req.workflowId) &&
            (!req.skillId || r.skillId === req.skillId) &&
            (!req.status || r.status === req.status) &&
            (!req.mode || r.mode === req.mode) &&
            matches(req.query, r.id, r.title, r.workflow?.name, r.skill?.name),
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
        .map((r) => ({
          id: r.id,
          title: r.title,
          mode: r.mode,
          status: r.status,
          version: r.version,
          workflow: r.workflow ? assetMetadata(r.workflow) : null,
          skill: pinnedSkill(r, state.snapshots)
            ? assetMetadata(pinnedSkill(r, state.snapshots)!)
            : null,
          project: (() => {
            const p = state.projects.find((p) => p.id === r.context.project);
            return p ? { id: p.id, name: p.name, root: p.root } : null;
          })(),
          stage: r.stage,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        })),
      req,
    );
  }
  runGet(id: string) {
    const { state } = this.core.state();
    const run = requireValue(
      state.runs.find((r) => r.id === id),
      'Run not found',
    );
    const snapshot = state.snapshots.find((s) => s.id === run.snapshotIds.at(-1));
    const { workflow, skill, handoffRequests, requestFingerprint, ...rest } = run;
    return {
      ...rest,
      workflow: workflow ? { ...assetMetadata(workflow), workflow: workflow.workflow } : null,
      skill: pinnedSkill(run, state.snapshots)
        ? assetMetadata(pinnedSkill(run, state.snapshots)!)
        : null,
      requirements: runRequirements(run, state.snapshots),
      handoffPreview: snapshot ? this.core.handoffPreview(id) : null,
    };
  }
  journals(input: unknown = {}) {
    const req = z.object(journalListShape).parse(input);
    if (req.since && req.until && req.since > req.until)
      throw new DomainError('INPUT', 'since must precede until');
    return page(
      this.core
        .state()
        .state.journals.filter(
          (j) =>
            (!req.runId || j.runId === req.runId) &&
            (!req.snapshotId || j.snapshotId === req.snapshotId) &&
            (!req.projectId || j.context.project === req.projectId) &&
            (!req.workflowId || j.context.workflow === req.workflowId) &&
            (!req.stage || j.context.stage === req.stage) &&
            (!req.kind || j.kind === req.kind) &&
            (!req.since || j.createdAt >= req.since) &&
            (!req.until || j.createdAt <= req.until) &&
            matches(req.query, j.id, j.observation, j.possibleCause),
        ),
      req,
    );
  }
  reviews(input: unknown = {}) {
    const req = z.object(reviewListShape).parse(input);
    return page(
      this.core
        .state()
        .state.reviews.filter(
          (r) =>
            (!req.status || r.status === req.status) &&
            (!req.journalId || r.journalIds.includes(req.journalId)) &&
            (!req.projectId || r.observedScopes.some((s) => s.project === req.projectId)) &&
            (!req.workflowId || r.observedScopes.some((s) => s.workflow === req.workflowId)) &&
            matches(req.query, r.id, r.reason),
        )
        .map(({ operations, items, preparedChanges, ...r }) => ({
          ...r,
          operationCount: operations.length,
        })),
      req,
    );
  }
  requestReview(input: unknown) {
    const req = z
      .object({ ...authorizationShape, journalIds: z.array(idSchema).min(1).max(100) })
      .strict()
      .parse(input);
    return this.core.requestReview(
      { journalIds: req.journalIds, reason: req.reason },
      userAttribution(req),
    );
  }
  decideReview(id: string, input: unknown) {
    const { decision, ...auth } = z.object(decisionShape).strict().parse(input);
    return this.core.decideReview(id, decision === 'approve', userAttribution(auth));
  }
  propose(input: unknown) {
    const req = z.object(proposalShape).strict().parse(input);
    userAttribution(req);
    return this.core.store.transaction((state, assets) => {
      const validated = this.core.validateChanges({
        operations: req.operations,
        summary: req.reason,
      });
      const proposal: DirectProposal = {
        ...req,
        id: `proposal-${randomUUID()}`,
        createdAt: new Date().toISOString(),
        status: 'pending',
        settingsVersion: state.settingsVersion ?? 0,
        preview: operationPreview(state, assets, req.operations, validated),
      };
      ((state as ManagementState).directProposals ??= []).unshift(proposal);
      return proposal;
    });
  }
  proposals(input: unknown = {}) {
    const req = z
      .object({ ...pageShape, status: z.enum(['pending', 'approved', 'rejected']).optional() })
      .parse(input);
    return page(
      ((this.core.state().state as ManagementState).directProposals ?? [])
        .filter(
          (p) =>
            (!req.status || p.status === req.status) &&
            matches(req.query, p.id, p.reason, p.userRequest),
        )
        .map(({ operations, preview, ...p }) => ({ ...p, operationCount: operations.length })),
      req,
    );
  }
  proposalGet(id: string) {
    return requireValue(
      (this.core.state().state as ManagementState).directProposals?.find((p) => p.id === id),
      'Proposal not found',
    );
  }
  decideProposal(id: string, input: unknown) {
    const req = z.object(decisionShape).strict().parse(input);
    const { decision, ...auth } = req;
    const audit = userAttribution(auth);
    const pending = (state: State) => {
      const proposal = requireValue(
        (state as ManagementState).directProposals?.find((p) => p.id === id),
        'Proposal not found',
      );
      if (proposal.status !== 'pending')
        throw new DomainError('PROPOSAL_STATE', 'Proposal has already been decided', 409);
      return proposal;
    };
    const record = (state: State, changeSetId?: string) => {
      const proposal = pending(state);
      proposal.status = decision === 'approve' ? 'approved' : 'rejected';
      proposal.decision = {
        ...req,
        decidedAt: new Date().toISOString(),
        ...(decision === 'approve' ? { approvedBy: audit.actor } : {}),
      };
      proposal.changeSetId = changeSetId;
      return proposal;
    };
    if (decision === 'reject')
      return { proposal: this.core.store.transaction((state) => record(state)) };
    const proposal = pending(this.core.state().state);
    const validated = this.core.validateChanges({
      operations: proposal.operations,
      summary: proposal.reason,
    });
    if (
      !isDeepStrictEqual(
        validated.changes.map((c) => (c.after ? inputOf(c.after) : null)),
        proposal.preview.changes.map((c) => (c.after ? inputOf(c.after) : null)),
      )
    )
      throw new DomainError(
        'PROPOSAL_STALE',
        'The effective changes differ from the saved proposal. Create a new proposal.',
        409,
      );
    const changeSet = this.core.changeAssets(
      { operations: proposal.operations, summary: proposal.reason },
      { ...audit, origin: 'user-request' },
      (state, change) => {
        if ((state.settingsVersion ?? 0) !== proposal.settingsVersion)
          throw new DomainError(
            'PROPOSAL_STALE',
            'Settings changed since this proposal. Review the impact in a new proposal.',
            409,
          );
        record(state, change.id);
      },
    );
    return { proposal: this.proposalGet(id), changeSet };
  }
  changeAssets(input: unknown) {
    const proposal = this.propose(input);
    const { userRequest, actor, reason } = proposal;
    return this.decideProposal(proposal.id, { decision: 'approve', userRequest, actor, reason });
  }
  rollback(input: unknown) {
    const { userRequest, actor, reason, ...req } = z.object(rollbackShape).strict().parse(input);
    if (
      req.changeSetId
        ? req.assetId || req.revision !== undefined || req.expectedRevision !== undefined
        : !req.assetId || req.revision === undefined || req.expectedRevision === undefined
    )
      throw new DomainError(
        'ROLLBACK_INPUT',
        'Specify changeSetId OR assetId, revision and expectedRevision.',
      );
    return this.core.rollback(req, userAttribution({ userRequest, actor, reason }));
  }
  resolve(input: unknown) {
    return compactResolution(
      this.core.preview(
        z
          .object({
            context: contextSchema.default({}),
            requested: z.array(idSchema).default([]),
          })
          .strict()
          .parse(input),
      ),
    );
  }
}

// The local UI action itself is the request; callers may provide a more specific reason/request.
export function uiAuthorization(
  input: { reason?: string; userRequest?: string } | undefined,
  action: string,
): Authorization {
  return {
    actor: { kind: 'user', id: 'local-user' },
    reason: input?.reason ?? action,
    userRequest: input?.userRequest ?? action,
  };
}

export function managementError(error: unknown, core?: Core, runId?: string) {
  const e = error as Error & { code?: string; details?: unknown; latestRun?: unknown };
  const result: Record<string, unknown> = {
    error:
      error instanceof z.ZodError
        ? error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n')
        : error instanceof Error
          ? error.message
          : 'Operation failed',
    code: error instanceof z.ZodError ? 'VALIDATION' : (e?.code ?? 'INTERNAL'),
  };
  if (e?.details !== undefined) result.details = e.details;
  if (e?.latestRun !== undefined) result.latestRun = e.latestRun;
  if (core && runId && /CONFLICT/.test(e?.code ?? '')) {
    try {
      result.latestRun = new Management(core).runGet(runId);
    } catch {
      /* Preserve original error. */
    }
    result.recoveryTool = 'aacl_run_get';
  }
  return result;
}
