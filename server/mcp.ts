import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Core } from './core.ts';
import { contextSchema, idSchema, operationSchema, requireValue } from './domain.ts';
import { bootstrap, materialize } from './adapters.ts';

export function createMcpServer(core: Core) {
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
          const result = fn(args);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: error instanceof Error ? error.message : 'Operation failed',
                }),
              },
            ],
          };
        }
      },
    );
  };
  register(
    'aacl_workflow_list',
    'List user-authored workflows. Never infer a workflow selection.',
    {},
    true,
    () => core.state().assets.filter((a) => a.type === 'workflow'),
  );
  register(
    'aacl_asset_list',
    'List canonical asset metadata. Use asset_get for full content.',
    { type: z.string().optional() },
    true,
    ({ type }) =>
      core
        .state()
        .assets.filter((a) => !type || a.type === type)
        .map(({ content, workflow, ...a }) => a),
  );
  register(
    'aacl_asset_get',
    'Read an asset and its decision history.',
    { id: idSchema },
    true,
    ({ id }) => ({
      asset: requireValue(
        core.state().assets.find((a) => a.id === id),
        'Assetが見つかりません',
      ),
      history: core.state().state.changesets.filter((c) => c.changes.some((a) => a.id === id)),
    }),
  );
  register(
    'aacl_context_resolve',
    'Deterministically preview explicit scopes, relations, dependencies and conflicts. Preview does not authorize execution.',
    { context: contextSchema.default({}), requested: z.array(idSchema).default([]) },
    true,
    (args) => core.preview(args),
  );
  register(
    'aacl_session_start',
    'Start a user-requested session. Only explicitly selected workflows enter workflow mode; plain instructions remain advisory.',
    {
      command: z.string().default(''),
      workflowId: idSchema.optional(),
      skillId: idSchema.optional(),
      instruction: z.string().default(''),
      context: contextSchema.default({}),
    },
    false,
    (args) => core.startRun(args),
  );
  register(
    'aacl_run_list',
    'Read execution state and permitted workflow definitions.',
    {},
    true,
    () => core.state().state.runs,
  );
  register(
    'aacl_context_handoff',
    'Record an execution snapshot and prepare runtime-pull or host-inject context. Request action=development before repository mutation; the Core validates the selected workflow boundary.',
    {
      runId: z.string(),
      context: contextSchema.default({}),
      delivery: z.enum(['runtime-pull', 'host-inject']).default('runtime-pull'),
      action: z.enum(['advisory', 'development']).default('advisory'),
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
    },
    false,
    (args) => core.addJournal(args),
  );
  register(
    'aacl_review_list',
    'List user-triggered journal reviews waiting for an external runtime to analyze.',
    {},
    true,
    () => core.state().state.reviews,
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
    'Submit an improvement proposal to an existing review. Separate observed scopes from proposed asset scopes and explain the reason. This never changes canonical assets; human approval is available only through the Core UI.',
    {
      id: z.string(),
      reason: z.string(),
      proposedBy: z.string(),
      operations: z.array(operationSchema),
    },
    false,
    ({ id, ...args }) => core.submitReview(id, args),
  );
  register(
    'aacl_diagnostics',
    'Read objective diagnostics and workflow/revision/stage/role context cost estimates. No automatic mutation.',
    {},
    true,
    () => ({ diagnostics: core.diagnostics(), metrics: core.metrics() }),
  );
  register(
    'aacl_materialize',
    'Render canonical context as generated Claude/Codex files. Returns file contents and never overwrites native configuration.',
    {
      runtime: z.enum(['claude', 'codex']),
      context: contextSchema.default({}),
      requested: z.array(idSchema).default([]),
    },
    true,
    (args) => materialize(core, args),
  );
  register('aacl_bootstrap', 'Get the stable, idempotent runtime contract.', {}, true, () => ({
    content: bootstrap(),
  }));
  server.registerResource(
    'runtime-bootstrap',
    'aacl://bootstrap',
    { mimeType: 'text/markdown', description: 'AACL runtime integration contract' },
    async (uri) => ({ contents: [{ uri: uri.href, text: bootstrap() }] }),
  );
  server.registerResource(
    'workflow-catalog',
    'aacl://workflows',
    { mimeType: 'application/json' },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          text: JSON.stringify(core.state().assets.filter((a) => a.type === 'workflow')),
        },
      ],
    }),
  );
  return server;
}
