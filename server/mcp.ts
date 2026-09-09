import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Core } from './core.ts';
import {
  configSchema,
  contextSchema,
  idSchema,
  reviewSubmissionShape,
  requireValue,
  bundlePathSchema,
} from './domain.ts';
import { onboardingRecordMcpRead } from './onboarding.ts';
import { registerOnboarding } from './onboarding-mcp.ts';
import { bootstrap, materialize } from './adapters.ts';
import { discoveryInput } from './discovery.ts';
import {
  Management,
  authorizationShape,
  pageShape,
  assetListShape,
  runListShape,
  journalListShape,
  reviewListShape,
  overlaySchema,
  proposalShape,
  decisionShape,
  rollbackShape,
  managementError,
} from './management.ts';

const startShape = {
  command: z.string().default(''),
  workflowId: idSchema.optional(),
  skillId: idSchema.optional(),
  instruction: z.string().default(''),
  context: contextSchema.default({}),
  requestId: z.string().trim().min(1).max(200).optional(),
};

export function createMcpServer(
  core: Core,
  endpoint = `http://localhost:${process.env.PORT ?? '4780'}/mcp`,
  management = new Management(core),
) {
  const server = new McpServer({ name: 'aacl', version: '0.1.0' });
  const register = (
    name: string,
    description: string,
    schema: z.ZodRawShape,
    readOnly: boolean,
    fn: (args: any) => unknown,
  ) => {
    server.registerTool(
      name,
      {
        description,
        inputSchema: schema,
        annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false },
      },
      async (args) => {
        try {
          const result = await fn(args);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  managementError(error, core, (args as { runId?: string }).runId),
                ),
              },
            ],
          };
        }
      },
    );
  };
  register(
    'aacl_project_list',
    'Find registered project IDs, names and roots on the Core host; never initialize implicitly.',
    pageShape,
    true,
    (args) => management.projects(args),
  );
  register(
    'aacl_project_initialize',
    'Initialize the explicitly requested existing directory on the Core host.',
    { ...authorizationShape, root: z.string().min(1), name: z.string().min(1) },
    false,
    (args) => management.initProject(args),
  );
  register(
    'aacl_model_list',
    'Find registered model IDs and providers.',
    { ...pageShape, provider: idSchema.optional() },
    true,
    (args) => management.models(args),
  );
  register(
    'aacl_model_discover',
    'Discover available models from local runtimes without running a task or changing settings.',
    discoveryInput.shape,
    true,
    (args) => management.discover(args),
  );
  register(
    'aacl_config_get',
    'Read providers, models, runtimes, bindings and current settingsVersion.',
    {},
    true,
    () => management.config(),
  );
  register(
    'aacl_config_update',
    'Save configuration for an explicit user request. Runtime actors must identify the requesting user. Use settingsVersion from config_get.',
    {
      ...authorizationShape,
      config: configSchema,
      expectedVersion: z.number().int().nonnegative(),
    },
    false,
    (args) => management.updateConfig(args),
  );
  register(
    'aacl_project_overlay_update',
    'Save project exceptions with the requesting user, reason and current settingsVersion.',
    {
      ...authorizationShape,
      projectId: idSchema,
      overlay: overlaySchema,
      expectedVersion: z.number().int().nonnegative(),
    },
    false,
    ({ projectId, ...args }) => management.updateOverlay(projectId, args),
  );
  register(
    'aacl_settings_history',
    'Read durable setting changes and their before/after values and user attribution.',
    { ...pageShape, kind: z.enum(['config', 'overlay']).optional(), targetId: idSchema.optional() },
    true,
    (args) => management.settingsHistory(args),
  );
  register(
    'aacl_settings_restore',
    'Restore a historical setting as a new version using its current expectedVersion and an explicit user request.',
    {
      ...authorizationShape,
      id: idSchema,
      side: z.enum(['before', 'after']).default('before'),
      expectedVersion: z.number().int().nonnegative(),
    },
    false,
    (args) => management.restoreSettings(args),
  );
  register(
    'aacl_asset_propose',
    'Persist a direct asset/workflow proposal with a user request, operations, diff and impact. No run or Journal is required; assets remain unchanged until decision.',
    proposalShape,
    false,
    (args) => management.propose(args),
  );
  register(
    'aacl_proposal_list',
    'Find direct user-request-backed proposals and their decision status.',
    { ...pageShape, status: z.enum(['pending', 'approved', 'rejected']).optional() },
    true,
    (args) => management.proposals(args),
  );
  register(
    'aacl_proposal_get',
    'Read a direct proposal, saved diff, impact and actual user attribution.',
    { id: idSchema },
    true,
    ({ id }) => management.proposalGet(id),
  );
  register(
    'aacl_proposal_decision',
    'Record the user decision for a direct proposal. Quote the actual user request; the runtime must identify the user, never itself as approver. A boolean alone is not authorization.',
    { id: idSchema, ...decisionShape },
    false,
    ({ id, ...args }) => management.decideProposal(id, args),
  );
  register(
    'aacl_asset_change',
    'Apply an already authorized conversational edit, preserving its proposal, diff, reason and requesting user. Only use when userRequest authorizes these operations.',
    proposalShape,
    false,
    (args) => management.changeAssets(args),
  );
  register(
    'aacl_asset_rollback',
    'Restore a changeset or asset revision with explicit user attribution and concurrency checks.',
    rollbackShape,
    false,
    (args) => management.rollback(args),
  );
  register(
    'aacl_workflow_list',
    'List user-authored workflows. Never infer a workflow selection.',
    pageShape,
    true,
    (args) => management.assets({ ...args, type: 'workflow' }),
  );
  register(
    'aacl_asset_list',
    'List canonical asset metadata. Use asset_get for full content.',
    assetListShape,
    true,
    (args) => management.assets(args),
  );
  register(
    'aacl_asset_get',
    'Read an asset and its decision history.',
    { id: idSchema },
    true,
    ({ id }) => {
      const asset = requireValue(
        core.state().assets.find((a) => a.id === id),
        'Assetが見つかりません',
      );
      onboardingRecordMcpRead(core, { assetId: asset.id, revision: asset.revision });
      return {
        asset,
        history: core
          .state()
          .state.changesets.filter((c) => c.changes.some((a) => a.id === id))
          .map(({ changes, proposalItems, ...c }) => ({
            ...c,
            changes: changes
              .filter((a) => a.id === id)
              .map(({ before, after, ...change }) => ({
                ...change,
                beforeRevision: before?.revision ?? null,
                afterRevision: after?.revision ?? null,
              })),
          })),
      };
    },
  );
  registerOnboarding(core, endpoint, register);
  register(
    'aacl_asset_file_get',
    'Read one support file from an asset bundle, optionally at a historical revision. Paths are bundle-relative; arbitrary filesystem paths are never read.',
    { id: idSchema, path: bundlePathSchema, revision: z.number().int().positive().optional() },
    true,
    ({ id, path, revision }) => {
      const asset = revision
        ? requireValue(
            core.assetHistory(id).revisions.find((a) => a.revision === revision),
            'Assetの改訂が見つかりません',
          )
        : requireValue(
            core.state().assets.find((a) => a.id === id),
            'Assetが見つかりません',
          );
      return {
        id,
        revision: asset.revision,
        path,
        content: requireValue(asset.files?.[path], '補助ファイルが見つかりません'),
      };
    },
  );
  register(
    'aacl_asset_relations',
    'Inspect saved asset relationships, workflow roles, role/model assignments and Model-specific scope. Does not select execution context.',
    { id: z.string().min(1).max(250) },
    true,
    ({ id }) => {
      const { assets, state } = core.state();
      const asset = assets.find((a) => a.id === id);
      const model = state.config.models.find((m) => m.id === id);
      requireValue(asset ?? model, '資産またはModelが見つかりません');
      return {
        id,
        type: asset?.type ?? 'model',
        outgoing: asset?.relations ?? [],
        dependencies: asset?.dependencies ?? [],
        incoming: assets.flatMap((a) =>
          (a.relations ?? []).filter((r) => r.target === id).map((r) => ({ sourceId: a.id, ...r })),
        ),
        stages:
          asset?.workflow?.stages.map((s) => ({
            stage: s.id,
            role: s.role,
            requiredAssets: s.requiredAssets,
          })) ?? [],
        modelBindings: state.config.bindings.filter(
          (b) => b.role === id || b.model === id || b.workflow === id,
        ),
        scopedAssets: assets
          .filter((a) => a.scope.model?.includes(id) || a.scope.role?.includes(id))
          .map((a) => ({
            id: a.id,
            name: a.name,
            type: a.type,
            revision: a.revision,
            scope: a.scope,
          })),
      };
    },
  );
  register(
    'aacl_asset_history',
    'Read all known revisions and change provenance, including deleted assets.',
    { id: idSchema },
    true,
    ({ id }) => core.assetHistory(id),
  );
  register(
    'aacl_asset_diff',
    'Compare two asset revisions: line diff of content and structured metadata changes. Revision 0 represents absence.',
    { id: idSchema, from: z.number().int().nonnegative(), to: z.number().int().nonnegative() },
    true,
    ({ id, ...args }) => core.assetDiff(id, args),
  );
  register(
    'aacl_asset_metrics',
    'Read snapshot-based per-asset/revision/workflow/stage/role context token estimates.',
    {},
    true,
    () => core.assetMetrics(),
  );
  register(
    'aacl_workflow_metrics',
    'Compare workflow revisions with sample counts, setting/asset revisions, actual attempts and results. Preparations are not work attempts.',
    {
      workflowId: idSchema.optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
    },
    true,
    (args) => core.workflowMetrics(args),
  );
  register(
    'aacl_context_resolve',
    'Deterministically preview explicit scopes, relations, dependencies and conflicts. Preview does not authorize execution.',
    { context: contextSchema.default({}), requested: z.array(idSchema).default([]) },
    true,
    (args) => management.resolve(args),
  );
  register(
    'aacl_session_start',
    'Start a user-requested session. Only explicitly selected workflows enter workflow mode; plain instructions remain advisory. A slash command may include trailing instructions; the separate instruction field is appended to them.',
    startShape,
    false,
    (args) => core.startRun(args),
  );
  register(
    'aacl_session_preflight',
    'Validate explicit selection and configuration before creating a run. No mutation.',
    startShape,
    true,
    (args) => {
      const { requestId, ...input } = args;
      return core.preflight(input);
    },
  );
  register(
    'aacl_run_list',
    'Find compact run summaries by project, workflow, skill, status or search text. Read one run with aacl_run_get.',
    runListShape,
    true,
    (args) => management.runs(args),
  );
  register(
    'aacl_run_get',
    'Read one latest run and its latest saved snapshot as a handoff preview. Never creates a snapshot, sends context or changes the run version.',
    { runId: idSchema },
    true,
    ({ runId }) => management.runGet(runId),
  );
  register(
    'aacl_context_handoff_preview',
    'Read the latest saved handoff without creating snapshots or changing the run version.',
    { runId: idSchema },
    true,
    ({ runId }) => core.handoffPreview(runId),
  );
  register(
    'aacl_run_restart',
    'Start a new linked run from the latest workflow revision. Explicitly select reusable artifacts; old completion evidence is not inherited.',
    {
      runId: idSchema,
      expectedVersion: z.number().int().positive(),
      instruction: z.string().optional(),
      reuseArtifacts: z.array(z.string()).max(100),
      reason: z.string().trim().min(1),
    },
    false,
    ({ runId, ...args }) => core.restartRun(runId, args),
  );
  register(
    'aacl_runtime_event',
    'Report actual runtime work for a uniquely identified attempt. Handoff retrieval alone does not mean work started.',
    {
      runId: idSchema,
      expectedVersion: z.number().int().positive(),
      event: z.enum(['started', 'resumed', 'result', 'failed', 'waiting-user']),
      requestId: z.string().trim().min(1).max(200).optional(),
      attemptId: z.string().trim().min(1),
      note: z.string().optional(),
      artifacts: z.record(z.string()).optional(),
      observedAt: z.string().datetime().optional(),
    },
    false,
    ({ runId, ...args }) => core.runtimeEvent(runId, args),
  );
  register(
    'aacl_context_handoff',
    'Record an execution snapshot and prepare runtime-pull or host-inject context. Returns project (id, name, root on the Core host) and the updated run version; use that version as expectedVersion for the next transition. Re-read aacl_run_get if another operation updates the run. Request action=development before repository mutation; the Core validates the selected workflow boundary.',
    {
      runId: z.string(),
      context: contextSchema.default({}),
      delivery: z.enum(['runtime-pull', 'host-inject']).default('runtime-pull'),
      action: z.enum(['advisory', 'development']).default('advisory'),
      expectedVersion: z.number().int().positive().optional(),
      requestId: z.string().trim().min(1).max(200).optional(),
    },
    false,
    ({ runId, ...args }) => core.handoff(runId, args),
  );
  register(
    'aacl_workflow_transition',
    'Choose a defined transition with current expectedVersion. Supply completion evidence and required artifacts. Retry/return require a reason.',
    {
      runId: z.string(),
      expectedVersion: z.number().int().positive(),
      to: idSchema.optional(),
      kind: z.enum(['advance', 'return', 'retry', 'reject', 'complete', 'cancel']),
      note: z.string().default(''),
      artifacts: z.record(z.string()).default({}),
      criteria: z.record(z.string()).default({}),
    },
    false,
    ({ runId, ...args }) => core.transition(runId, args),
  );
  register(
    'aacl_snapshot_get',
    'Read immutable execution context including asset and workflow revisions.',
    { id: z.string() },
    true,
    ({ id }) => core.getSnapshot(id),
  );
  register(
    'aacl_journal_append',
    'Attach a first-hand observation to a real execution snapshot. This does not alter assets or infer scope.',
    {
      snapshotId: z.string(),
      kind: z.enum(['friction', 'missing-support', 'defect', 'success', 'improvement']),
      observation: z.string(),
      possibleCause: z.string().default(''),
      confidence: z.number().min(0).max(1).default(0.8),
      observedAt: z.string().datetime().optional(),
      attemptId: z.string().trim().min(1).optional(),
    },
    false,
    (args) => core.addJournal(args),
  );
  register(
    'aacl_journal_list',
    'Find observations by run, snapshot, project, workflow, stage, kind and recording date.',
    journalListShape,
    true,
    (args) => management.journals(args),
  );
  register(
    'aacl_review_start',
    'Start a Journal review requested by the user. Choose actual observation IDs; direct authoring uses asset_propose instead.',
    { ...authorizationShape, journalIds: z.array(idSchema).min(1).max(100) },
    false,
    (args) => management.requestReview(args),
  );
  register(
    'aacl_review_list',
    'List user-triggered journal reviews waiting for an external runtime to analyze.',
    reviewListShape,
    true,
    (args) => management.reviews(args),
  );
  register(
    'aacl_review_preview',
    'Read proposed changes and structured diffs before a user decision.',
    { id: idSchema },
    true,
    ({ id }) => core.reviewPreview(id),
  );
  register(
    'aacl_review_decision',
    'Apply or reject a pending Journal review based on the actual user request. Runtime actors must name the user separately; no UI token is required.',
    { id: idSchema, ...decisionShape },
    false,
    ({ id, ...args }) => management.decideReview(id, args),
  );
  register(
    'aacl_review_get',
    'Get journals, snapshots, provenance and diagnostic evidence for an existing user-triggered review. Interpret evidence semantically in your runtime.',
    { id: z.string() },
    true,
    ({ id }) => core.reviewBundle(id),
  );
  register(
    'aacl_review_submit',
    'Submit items, each with operation, proposedScope, proposedRelations, reason and evidence referencing journals/snapshots from this review. For project-owned assets, proposedScope.project must be [asset.projectId]. Core derives observed scopes from evidence. For no change submit items: []. Legacy operations is accepted with review-level evidence; send exactly one format. Record a subsequent user decision with aacl_review_decision or the UI.',
    {
      id: z.string(),
      ...reviewSubmissionShape,
    },
    false,
    ({ id, ...args }) => core.submitReview(id, args),
  );
  register(
    'aacl_diagnostics',
    'Read objective diagnostics and workflow/revision/stage/role context cost estimates. No automatic mutation.',
    {},
    true,
    () => ({
      diagnostics: core.diagnostics(),
      metrics: core.metrics(),
      assetMetrics: core.assetMetrics(),
    }),
  );
  register(
    'aacl_materialize',
    'Render canonical context as generated Claude/Codex files. Returns file contents and never overwrites native configuration.',
    {
      runtime: z.enum(['claude', 'codex', 'cursor', 'other']),
      context: contextSchema.default({}),
      requested: z.array(idSchema).default([]),
    },
    true,
    (args) => materialize(core, { ...args, endpoint }),
  );
  register('aacl_bootstrap', 'Get the stable, idempotent runtime contract.', {}, true, () => ({
    content: bootstrap(endpoint),
  }));
  server.registerResource(
    'runtime-bootstrap',
    'aacl://bootstrap',
    { mimeType: 'text/markdown', description: 'AACL runtime integration contract' },
    async (uri) => ({ contents: [{ uri: uri.href, text: bootstrap(endpoint) }] }),
  );
  server.registerResource(
    'workflow-catalog',
    'aacl://workflows',
    { mimeType: 'application/json' },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          text: JSON.stringify(management.assets({ type: 'workflow' })),
        },
      ],
    }),
  );
  return server;
}
