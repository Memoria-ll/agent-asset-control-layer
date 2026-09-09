import express, { type ErrorRequestHandler } from 'express';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ZodError } from 'zod';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Core } from './core.ts';
import { DomainError } from './domain.ts';
import { createMcpServer } from './mcp.ts';
import { materialize, bootstrap } from './adapters.ts';
import { discoveryInput, discoveryService, discoverModels } from './discovery.ts';

export function createApp(core: Core, discovery = discoverModels) {
  const app = express();
  const discover = discoveryService(discovery);
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
  app.get('/api/state', (_req, res) => res.json({ ...core.overview(), humanToken }));
  // Human control endpoints are deliberately absent from the MCP tool catalog.
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
  app.post('/api/starter', (_req, res) => res.json(core.installStarter()));
  app.post('/api/assets/change', (req, res) => res.json(core.changeAssets(req.body)));
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
  app.post('/api/import', (req, res) => res.json(core.importNative(req.body)));
  app.post('/api/projects', (req, res) => res.json(core.initProject(req.body)));
  app.put('/api/projects/:id/overlay', (req, res) =>
    res.json(core.updateOverlay(req.params.id, req.body)),
  );
  app.put('/api/config', (req, res) => res.json(core.updateConfig(req.body)));
  app.post('/api/models/discover', async (req, res) =>
    res.json(await discover(discoveryInput.parse(req.body))),
  );
  app.post('/api/resolve', (req, res) => res.json(core.preview(req.body)));
  app.post('/api/runs', (req, res) => res.json(core.startRun(req.body)));
  app.post('/api/runs/:id/transition', (req, res) =>
    res.json(core.transition(req.params.id, req.body)),
  );
  app.post('/api/runs/:id/handoff', (req, res) => res.json(core.handoff(req.params.id, req.body)));
  app.get('/api/snapshots/:id', (req, res) => res.json(core.getSnapshot(req.params.id)));
  app.post('/api/journals', (req, res) => res.json(core.addJournal(req.body)));
  app.post('/api/reviews', (req, res) => res.json(core.requestReview(req.body)));
  app.get('/api/reviews/:id', (req, res) => res.json(core.reviewBundle(req.params.id)));
  app.get('/api/reviews/:id/preview', (req, res) => res.json(core.reviewPreview(req.params.id)));
  app.post('/api/reviews/:id/proposal', (req, res) =>
    res.json(core.submitReview(req.params.id, req.body)),
  );
  app.post('/api/reviews/:id/decision', (req, res) => {
    if (typeof req.body.approve !== 'boolean')
      throw new DomainError('INPUT', 'approveにはbooleanが必要です');
    res.json(core.decideReview(req.params.id, req.body.approve));
  });
  app.post('/api/rollback', (req, res) => res.json(core.rollback(req.body)));
  const endpoint = (req: express.Request) => `${req.protocol}://${req.get('host')}/mcp`;
  app.post('/api/materialize', (req, res) =>
    res.json(materialize(core, { endpoint: endpoint(req), ...req.body })),
  );
  app.get('/api/bootstrap', (req, res) => res.type('text/markdown').send(bootstrap(endpoint(req))));
  app.post('/mcp', async (req, res, next) => {
    const server = createMcpServer(core, endpoint(req));
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
  return app;
}
export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (res.headersSent) return;
  const status =
    error instanceof DomainError
      ? error.status
      : error instanceof ZodError
        ? 400
        : (error.status ?? 500);
  if (status >= 500) console.error(error);
  res.status(status).json({
    error:
      error instanceof ZodError
        ? error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n')
        : (error.message ?? 'Internal error'),
    code: error.code ?? 'VALIDATION',
  });
};
export function serveProduction(app: ReturnType<typeof express>, root: string) {
  app.use(express.static(path.join(root, 'dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(root, 'dist', 'index.html')));
}
