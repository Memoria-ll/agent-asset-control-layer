import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Core } from './core.ts';
import { Store } from './store.ts';
import { createApp, errorHandler, serveProduction } from './app.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const store = new Store(process.env.AACL_DATA_DIR ?? path.join(root, '.aacl-data'));
const app = createApp(new Core(store));
let vite: import('vite').ViteDevServer | undefined;
if (process.argv.includes('--dev')) {
  vite = await (
    await import('vite')
  ).createServer({ root, server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
} else serveProduction(app, root);
app.use(errorHandler);
const port = Number(process.env.PORT ?? 4780);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  store.close();
  throw new Error('PORTが不正です');
}
const server = app.listen(port, '127.0.0.1', () =>
  console.log(
    `AACL ready: http://localhost:${port}\nMCP: http://localhost:${port}/mcp\nData: ${store.root}`,
  ),
);
server.on('error', (error) => {
  console.error(error);
  store.close();
  process.exitCode = 1;
  void vite?.close();
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.closeAllConnections();
  server.close();
  await vite?.close();
  store.close();
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
