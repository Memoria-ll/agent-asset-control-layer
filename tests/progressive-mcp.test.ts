import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Core } from '../server/core.ts';
import { Store } from '../server/store.ts';
import { createApp, errorHandler } from '../server/app.ts';
import { assetSchema } from '../server/domain.ts';

test('public MCP and HTTP support model-free work, explicit pinned Skill reading and coherent standalone export via CLI', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aacl-progressive-http-'));
  const store = new Store(path.join(root, 'core')),
    core = new Core(store);
  core.changeAssets({
    summary: 'fixture',
    operations: [
      {
        id: 'role',
        name: 'Reviewer',
        type: 'role',
        relations: [
          { target: 'skill', kind: 'required', origin: 'manual', reason: 'Role knowledge' },
        ],
      },
      {
        id: 'flow',
        name: 'Flow',
        type: 'workflow',
        workflow: {
          developmentCapable: false,
          entryStage: 'review',
          entryRole: 'role',
          stages: [{ id: 'review', name: 'Review', role: 'role' }],
        },
      },
      {
        id: 'skill',
        name: 'Review Skill',
        description: 'Use for inspecting a change',
        type: 'skill',
        content: 'PRIVATE_SKILL_BODY',
        files: { 'references/check.md': 'PRIVATE_HELPER_BODY' },
      },
    ].map((a) => ({ op: 'upsert', expectedRevision: 0, asset: assetSchema.parse(a) })),
  });
  const app = createApp(core);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = new Client({ name: 'runtime', version: '1' });
  t.after(async () => {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text?: string }[]).find(
      (c) => c.type === 'text',
    )!.text!;
    assert(!result.isError, text);
    return JSON.parse(text);
  };
  const advisory = await call('aacl_context_resolve');
  assert(advisory.skillCandidates.some((s: { id: string }) => s.id === 'aacl-asset-authoring'));
  assert(!JSON.stringify(advisory).includes('Classify the behavior'));
  const run = await call('aacl_session_start', { workflowId: 'flow' });
  assert(!JSON.stringify(run).includes('PRIVATE_SKILL_BODY'));
  const handoff = await call('aacl_context_handoff', { runId: run.id });
  assert.equal(handoff.launch.modelPolicy, 'runtime-default');
  assert(!('model' in handoff.launch));
  const started = await call('aacl_runtime_event', {
    runId: run.id,
    expectedVersion: handoff.version,
    event: 'started',
    attemptId: 'child',
    actualModel: 'unregistered-native-model',
  });
  assert.equal(started.handoffPreview.actualModel, 'unregistered-native-model');
  assert(!JSON.stringify(started).includes('PRIVATE_SKILL_BODY'));
  const retrieval = started.handoffPreview.skillCandidates.find(
    (s: { id: string }) => s.id === 'skill',
  ).retrieval;
  const body = await call(retrieval.tool, {
    ...retrieval.arguments,
    usage: 'use',
    attemptId: 'child',
  });
  assert.equal(body.asset.content, 'PRIVATE_SKILL_BODY');
  assert(!JSON.stringify(body).includes('PRIVATE_HELPER_BODY'));
  assert.equal(
    (await call('aacl_asset_file_get', { id: 'skill', revision: 1, path: 'references/check.md' }))
      .content,
    'PRIVATE_HELPER_BODY',
  );
  const exportInput = { assetIds: ['flow'], mode: 'standalone', runtime: 'codex' };
  const bundle = await call('aacl_export_bundle', exportInput);
  assert.equal(bundle.outputSpecifications.requiresCore, false);
  assert(bundle.assets.some((a: { id: string }) => a.id === 'skill'));
  assert(bundle.files.some((file: { content: string }) => file.content === 'PRIVATE_HELPER_BODY'));
  const state = (await (await fetch(`${base}/api/state`)).json()) as { humanToken: string };
  const response = await fetch(`${base}/api/export-bundle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-AACL-Token': state.humanToken },
    body: JSON.stringify(exportInput),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), bundle);
  const inputFile = path.join(root, 'export.json'),
    output = path.join(root, 'output');
  fs.writeFileSync(inputFile, JSON.stringify(exportInput));
  await promisify(execFile)(
    process.execPath,
    ['--import', 'tsx', 'server/cli.ts', 'export-bundle', inputFile, output],
    { cwd: path.resolve('.'), env: { ...process.env, AACL_API_URL: base } },
  );
  for (const file of bundle.files)
    assert.equal(fs.readFileSync(path.join(output, file.path), 'utf8'), file.content);
  const solo = await call('aacl_session_start', { skillId: 'skill' });
  assert(!JSON.stringify(solo).includes('PRIVATE_SKILL_BODY'));
  const completed = await call('aacl_workflow_transition', {
    runId: solo.id,
    expectedVersion: solo.version,
    kind: 'complete',
  });
  assert.equal(completed.status, 'completed');
  assert(!JSON.stringify(completed).includes('PRIVATE_SKILL_BODY'));
});
