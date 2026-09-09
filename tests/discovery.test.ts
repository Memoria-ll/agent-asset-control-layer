import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  discoverCodex,
  discoverClaude,
  discoverLocal,
  discoveryService,
  localEndpoint,
  type Discovery,
} from '../server/discovery.ts';
import { Core } from '../server/core.ts';
import { Store } from '../server/store.ts';
import { createApp, errorHandler } from '../server/app.ts';

test('CLI discovery uses initialization/catalog only, follows pagination and never returns credentials', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aacl-discover-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const executable = path.join(dir, 'fake-cli.mjs');
  const log = path.join(dir, 'requests.jsonl');
  fs.writeFileSync(
    executable,
    `#!${process.execPath}
import readline from 'node:readline';
import fs from 'node:fs';
if (process.argv.includes('auth')) { console.log(JSON.stringify({loggedIn: true, email: 'private@example.test', token: 'secret'})); process.exit(0); }
const claude = process.argv.includes('--print');
readline.createInterface({input:process.stdin}).on('line', line => {
  const req=JSON.parse(line); fs.appendFileSync(${JSON.stringify(log)}, line+'\\n');
  if (claude) {
    console.log(JSON.stringify({type:'control_response', response:{subtype:'success', request_id:req.request_id, response:{models:[{value:'sonnet',displayName:'Sonnet'}], account:{token:'secret'}}}}));
  } else {
    if (!req.id) return;
    let result = {};
    if (req.method==='account/read') result={account:{type:'chatgpt',email:'private@example.test'}};
    if (req.method==='model/list') result=req.params.cursor ? {data:[{model:'test-2',displayName:'Two'}], nextCursor:null} : {data:[{model:'test-1',displayName:'One'}],nextCursor:'next'};
    console.log(JSON.stringify({id:req.id,result}));
  }
});`,
    { mode: 0o755 },
  );
  const codex = await discoverCodex(executable);
  const claude = await discoverClaude(executable);
  assert.equal(codex.status, 'connected');
  assert.deepEqual(
    codex.models.map((m) => m.id),
    ['test-1', 'test-2'],
  );
  assert.deepEqual(claude.models, [{ id: 'sonnet', name: 'Sonnet' }]);
  assert.doesNotMatch(JSON.stringify([codex, claude]), /secret|private@example/);
  const requests = fs
    .readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.ok(
    requests.every((r) =>
      r.method
        ? ['initialize', 'initialized', 'account/read', 'model/list'].includes(r.method)
        : r.request.subtype === 'initialize',
    ),
  );
  assert.equal(requests.find((r) => r.method === 'account/read').params.refreshToken, false);
});

test('logged-out CLI and failed child process are explicit, with no invented models', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aacl-discover-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'logged-out');
  fs.writeFileSync(file, `#!${process.execPath}\nconsole.log(JSON.stringify({loggedIn:false}));`, {
    mode: 0o755,
  });
  const result = await discoverClaude(file);
  assert.equal(result.status, 'login-required');
  assert.equal(result.models.length, 0);
  assert.equal((await discoverCodex(path.join(dir, 'missing'))).status, 'error');
});

test('local discovery reads installed models, preserves native IDs, bounds responses and rejects redirect', async (t) => {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url!);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/tags')
      res.end(
        JSON.stringify({ models: [{ name: 'llama3.2:latest' }, { name: 'llama3.2:latest' }] }),
      );
    else if (req.url === '/v1/models')
      res.end(JSON.stringify({ data: [{ id: 'org/model-Q4_K_M.gguf' }] }));
    else if (req.url?.startsWith('/large/')) res.end('x'.repeat(3 * 1024 * 1024));
    else {
      res.writeHead(302, { Location: 'http://example.com' });
      res.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const ollama = await discoverLocal('ollama', base);
  assert.deepEqual(ollama.models, [{ id: 'llama3.2:latest', name: 'llama3.2:latest' }]);
  const lm = await discoverLocal('lmstudio', base + '/v1');
  assert.equal(lm.models[0].id, 'org/model-Q4_K_M.gguf');
  assert.equal((await discoverLocal('llamacpp', base)).status, 'connected');
  assert.equal((await discoverLocal('ollama', base + '/redirect')).status, 'unavailable');
  assert.equal((await discoverLocal('ollama', base + '/large')).status, 'unavailable');
  assert.ok(requests.every((r) => /tags|models/.test(r)));
  assert.throws(() => localEndpoint('https://example.com'));
  assert.throws(() => localEndpoint('http://user:secret@localhost'));
  assert.throws(() => localEndpoint('file:///etc/passwd'));
  assert.throws(() => localEndpoint('http://169.254.169.254'));
  assert.equal(localEndpoint('http://192.168.1.3:11434/'), 'http://192.168.1.3:11434');
});

test('discovery requires human API token, coalesces concurrent calls and does not mutate config', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aacl-discover-http-'));
  const store = new Store(dir);
  const core = new Core(store);
  let calls = 0;
  const sample: Discovery = { checkedAt: new Date().toISOString(), sources: [] };
  const app = createApp(core, async () => {
    calls++;
    return sample;
  });
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  assert.equal(
    (
      await fetch(base + '/api/models/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    403,
  );
  const before = await (await fetch(base + '/api/state')).json();
  const res = await fetch(base + '/api/models/discover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-AACL-Token': before.humanToken },
    body: '{}',
  });
  assert.equal(res.status, 200);
  assert.equal(calls, 1);
  assert.deepEqual(core.overview().config, before.config);
  let release!: (value: Discovery) => void;
  const service = discoveryService(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const first = service({});
  const second = service({});
  assert.equal(first, second);
  assert.throws(() => service({ ollama: 'http://127.0.0.1:1' }));
  release(sample);
  await first;
});
