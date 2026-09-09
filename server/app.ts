import express, { type ErrorRequestHandler } from 'express';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ZodError } from 'zod';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Core } from './core.ts';
import { DomainError } from './domain.ts';
import { createMcpServer } from './mcp.ts';
import { materialize, bootstrap } from './adapters.ts';
import { discoverModels } from './discovery.ts';
import {
  onboardingDiscover,
  onboardingImport,
  onboardingGet,
  onboardingList,
  onboardingOrganize,
  onboardingCutover,
  onboardingRestore,
  onboardingPlan,
  onboardingConnect,
} from './onboarding.ts';
import { Management, managementError, uiAuthorization } from './management.ts';

export function createApp(core: Core, discovery = discoverModels) {
  const app = express();
  const management = new Management(core, discovery);
  const humanToken = randomBytes(32).toString('hex');
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const host = req.hostname;
    if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)) {
      res.status(403).json({ error: 'Localhost only' });
      return;
    }
    if (req.headers.origin) {
      try {
        const origin = new URL(req.headers.origin);
        if (origin.host !== req.headers.host || !['http:', 'https:'].includes(origin.protocol)) {
          res.status(403).json({ error: 'Cross-origin request rejected' });
          return;
        }
      } catch {
        res.status(403).json({ error: 'Invalid Origin' });
        return;
      }
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '3mb' }));
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', version: '0.1.0' }));
  app.get('/api/state', (_req, res) =>
    res.json({
      ...core.overview(),
      humanToken,
      settingsVersion: management.config().settingsVersion,
      settingsHistory: management.settingsHistory().items,
      directProposals: management.proposals().items,
    }),
  );
  // Browser mutations retain CSRF protection. MCP uses explicit user-request attribution.
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD'].includes(req.method)) return next();
    const token = req.header('X-AACL-Token') ?? '';
    if (
      !/^[0-9a-f]{64}$/.test(token) ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(humanToken))
    ) {
      res.status(403).json({ error: 'UI token required' });
      return;
    }
    next();
  });
  app.post('/api/starter', async (_req, res) => res.json(await core.installStarter()));
  app.get('/api/assets', (req, res) =>
    res.json(
      management.assets({
        ...req.query,
        enabled: req.query.enabled === undefined ? undefined : req.query.enabled === 'true',
      }),
    ),
  );
  app.get('/api/workflows', (req, res) =>
    res.json(management.assets({ ...req.query, type: 'workflow' })),
  );
  app.post('/api/assets/change', async (req, res) => {
    const result = await management.changeAssets({
      operations: req.body.operations,
      ...uiAuthorization(
        { ...req.body, reason: req.body.reason ?? req.body.summary },
        'Save asset changes from the UI',
      ),
    });
    res.json(result.changeSet);
  });
  app.get('/api/proposals', (req, res) => res.json(management.proposals(req.query)));
  app.post('/api/proposals', async (req, res) =>
    res.json(
      await management.propose({
        operations: req.body.operations,
        ...uiAuthorization(req.body, 'Create an asset proposal from the UI'),
      }),
    ),
  );
  app.get('/api/proposals/:id', (req, res) => res.json(management.proposalGet(req.params.id)));
  app.post('/api/proposals/:id/decision', async (req, res) =>
    res.json(
      await management.decideProposal(req.params.id, {
        decision: req.body.decision,
        ...uiAuthorization(req.body, `${req.body.decision} proposal ${req.params.id} from the UI`),
      }),
    ),
  );
  app.get('/api/assets/:id/history', (req, res) => res.json(core.assetHistory(req.params.id)));
  app.get('/api/assets/:id/diff', (req, res) =>
    res.json(
      core.assetDiff(req.params.id, {
        from: req.query.from === undefined || req.query.from === '' ? NaN : Number(req.query.from),
        to: req.query.to === undefined || req.query.to === '' ? NaN : Number(req.query.to),
      }),
    ),
  );
  app.get('/api/metrics/assets', (_req, res) => res.json(core.assetMetrics()));
  app.get('/api/metrics/workflows', (req, res) => res.json(core.workflowMetrics(req.query)));
  app.post('/api/import', async (req, res) => res.json(await core.importNative(req.body)));
  app.get('/api/onboarding', (_req, res) => res.json(onboardingList(core)));
  app.get('/api/onboarding/:id', (req, res) =>
    res.json(onboardingGet(core, { id: req.params.id })),
  );
  app.post('/api/onboarding/discover', (req, res) => res.json(onboardingDiscover(core, req.body)));
  app.post('/api/onboarding/import', (req, res) => res.json(onboardingImport(core, req.body)));
  app.post('/api/onboarding/plan', (req, res) =>
    res.json(
      onboardingPlan(core, { endpoint: `${req.protocol}://${req.get('host')}/mcp`, ...req.body }),
    ),
  );
  app.post('/api/onboarding/connect', (req, res) =>
    res.json(
      onboardingConnect(core, {
        endpoint: `${req.protocol}://${req.get('host')}/mcp`,
        ...req.body,
      }),
    ),
  );
  app.post('/api/onboarding/organize', (req, res) => res.json(onboardingOrganize(core, req.body)));
  app.post('/api/onboarding/cutover', (req, res) => res.json(onboardingCutover(core, req.body)));
  app.post('/api/onboarding/restore', (req, res) => res.json(onboardingRestore(core, req.body)));
  app.get('/api/projects', (req, res) => res.json(management.projects(req.query)));
  app.post('/api/projects', async (req, res) =>
    res.json(
      await management.initProject({
        root: req.body.root,
        name: req.body.name,
        ...uiAuthorization(req.body, 'Initialize the selected project from the UI'),
      }),
    ),
  );
  app.put('/api/projects/:id/overlay', async (req, res) => {
    const { reason, userRequest, expectedVersion, ...overlay } = req.body;
    const result = await management.updateOverlay(req.params.id, {
      overlay: req.body.overlay ?? overlay,
      expectedVersion: expectedVersion ?? management.config().settingsVersion,
      ...uiAuthorization({ reason, userRequest }, `Save overlay for ${req.params.id} from the UI`),
    });
    res.json(result.project);
  });
  app.get('/api/config', (_req, res) => res.json(management.config()));
  app.put('/api/config', async (req, res) => {
    const { reason, userRequest, expectedVersion, ...config } = req.body;
    const result = await management.updateConfig({
      config: req.body.config ?? config,
      expectedVersion: expectedVersion ?? management.config().settingsVersion,
      ...uiAuthorization({ reason, userRequest }, 'Save model configuration from the UI'),
    });
    res.json(result.config);
  });
  app.get('/api/settings/history', (req, res) => res.json(management.settingsHistory(req.query)));
  app.post('/api/settings/restore', async (req, res) =>
    res.json(
      await management.restoreSettings({
        id: req.body.id,
        side: req.body.side,
        expectedVersion: req.body.expectedVersion,
        ...uiAuthorization(req.body, `Restore setting ${req.body.id} from the UI`),
      }),
    ),
  );
  app.get('/api/models', (req, res) => res.json(management.models(req.query)));
  app.post('/api/models/discover', async (req, res) =>
    res.json(await management.discover(req.body)),
  );
  app.post('/api/resolve', async (req, res) => res.json(await core.preview(req.body)));
  app.get('/api/runs', (req, res) => res.json(management.runs(req.query)));
  app.post('/api/runs/preflight', async (req, res) => res.json(await core.preflight(req.body)));
  app.post('/api/runs', async (req, res) => res.json(await core.startRun(req.body)));
  app.get('/api/runs/:id', (req, res) => res.json(management.runGet(req.params.id)));
  app.get('/api/runs/:id/handoff', (req, res) => res.json(core.handoffPreview(req.params.id)));
  app.post('/api/runs/:id/restart', async (req, res) =>
    res.json(await core.restartRun(req.params.id, req.body)),
  );
  app.post('/api/runs/:id/runtime-event', async (req, res) =>
    res.json(await core.runtimeEvent(req.params.id, req.body)),
  );
  app.post('/api/runs/:id/transition', async (req, res) =>
    res.json(await core.transition(req.params.id, { ...req.body, actor: 'local-user' })),
  );
  app.post('/api/runs/:id/handoff', async (req, res) =>
    res.json(await core.handoff(req.params.id, req.body)),
  );
  app.get('/api/snapshots/:id', (req, res) => res.json(core.getSnapshot(req.params.id)));
  app.get('/api/journals', (req, res) => res.json(management.journals(req.query)));
  app.post('/api/journals', async (req, res) => res.json(await core.addJournal(req.body)));
  app.get('/api/reviews', (req, res) => res.json(management.reviews(req.query)));
  app.post('/api/reviews', async (req, res) =>
    res.json(
      await management.requestReview({
        journalIds: req.body.journalIds,
        ...uiAuthorization(req.body, 'Review selected Journals from the UI'),
      }),
    ),
  );
  app.get('/api/reviews/:id', (req, res) => res.json(core.reviewBundle(req.params.id)));
  app.get('/api/reviews/:id/preview', (req, res) => res.json(core.reviewPreview(req.params.id)));
  app.post('/api/reviews/:id/proposal', async (req, res) =>
    res.json(await core.submitReview(req.params.id, req.body)),
  );
  app.post('/api/reviews/:id/decision', async (req, res) => {
    if (req.body.decision === undefined && typeof req.body.approve !== 'boolean')
      throw new DomainError('INPUT', 'approveにはbooleanが必要です');
    const decision = req.body.decision ?? (req.body.approve ? 'approve' : 'reject');
    res.json(
      await management.decideReview(req.params.id, {
        decision,
        ...uiAuthorization(req.body, `${decision} review ${req.params.id} from the UI`),
      }),
    );
  });
  app.post('/api/rollback', async (req, res) =>
    res.json(
      await management.rollback({
        ...req.body,
        ...uiAuthorization(req.body, 'Restore selected asset history from the UI'),
      }),
    ),
  );
  const endpoint = (req: express.Request) => `${req.protocol}://${req.get('host')}/mcp`;
  app.post('/api/materialize', async (req, res) =>
    res.json(await materialize(core, { endpoint: endpoint(req), ...req.body })),
  );
  app.get('/api/bootstrap', (req, res) => res.type('text/markdown').send(bootstrap(endpoint(req))));
  app.post('/mcp', async (req, res, next) => {
    const server = createMcpServer(core, endpoint(req), management);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      next(e);
    }
  });
  app.all('/mcp', (_req, res) => res.status(405).json({ error: 'Use Streamable HTTP POST' }));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown endpoint' }));
  app.locals.core = core;
  return app;
}
export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (res.headersSent) return;
  const status =
    error instanceof DomainError
      ? error.status
      : error instanceof ZodError
        ? 400
        : (error.status ?? 500);
  if (status >= 500) console.error(error);
  const runId = req.originalUrl.match(/^\/api\/runs\/([^/?]+)/)?.[1];
  res.status(status).json(managementError(error, req.app.locals.core, runId));
};
export function serveProduction(app: ReturnType<typeof express>, root: string) {
  app.use(express.static(path.join(root, 'dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(root, 'dist', 'index.html')));
}
