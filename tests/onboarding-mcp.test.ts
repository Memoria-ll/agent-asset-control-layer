import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Core } from '../server/core.ts';
import { Store } from '../server/store.ts';
import { createApp, errorHandler } from '../server/app.ts';
import { inputOf } from '../server/domain.ts';

test('production HTTP MCP tools complete native onboarding, preserve files and keep unrelated history out of asset reads', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aacl-onboard-http-'));
  const native = path.join(root, '.codex');
  fs.mkdirSync(path.join(native, 'skills', 'sample', 'references'), { recursive: true });
  const skillPath = path.join(native, 'skills', 'sample', 'SKILL.md');
  fs.writeFileSync(
    skillPath,
    '---\nname: Sample\ndescription: Test sample\n---\nUse references/check.md.',
  );
  fs.writeFileSync(
    path.join(native, 'skills', 'sample', 'references', 'check.md'),
    'SUPPORT_CONTENT',
  );
  fs.writeFileSync(path.join(native, 'auth.json'), '{"secret":"MUST_NEVER_APPEAR"}');
  fs.writeFileSync(path.join(native, 'config.toml'), 'model="existing"\n');
  const store = new Store(path.join(root, 'data')),
    core = new Core(store);
  const app = createApp(core);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as { port: number };
  const client = new Client({ name: 'test-runtime', version: '1' });
  t.after(async () => {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)),
  );
  async function call(name: string, args: Record<string, unknown> = {}, error?: string) {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text?: string }[]).find(
      (c) => c.type === 'text',
    )!.text!;
    assert.ok(!text.includes('MUST_NEVER_APPEAR'));
    const body = JSON.parse(text);
    if (error) {
      assert.equal(body.code, error);
      assert.equal(result.isError, true);
    } else assert.ok(!result.isError, text);
    return body;
  }
  const discovery = await call('aacl_onboarding_discover', {
    roots: [{ path: native, runtime: 'codex' }],
    includeDefaults: false,
  });
  const imported = await call('aacl_onboarding_import', { id: discovery.id });
  assert.equal(imported.phase, 'imported');
  const connected = await call('aacl_onboarding_connect', {
    id: discovery.id,
    userRequest: 'Connect AACL while preserving my current configuration',
  });
  assert.equal(connected.connection.phase, 'installed');
  assert.match(fs.readFileSync(path.join(native, 'config.toml'), 'utf8'), /model="existing"/);
  assert.match(fs.readFileSync(path.join(native, 'config.toml'), 'utf8'), /mcp_servers.aacl/);
  const assetId = imported.selected[0];
  await call(
    'aacl_onboarding_verify',
    { id: discovery.id, userRequest: 'Import my assets' },
    'MCP_READ_REQUIRED',
  );
  const asset = (await call('aacl_asset_get', { id: assetId })).asset;
  assert.equal(
    (await call('aacl_asset_file_get', { id: assetId, path: 'references/check.md' })).content,
    'SUPPORT_CONTENT',
  );
  assert.equal(asset.enabled, false);
  await call('aacl_onboarding_verify', { id: discovery.id, userRequest: 'Import my assets' });
  const current = core.state().assets.find((a) => a.id === assetId)!;
  const organized = await call('aacl_onboarding_organize', {
    id: discovery.id,
    userRequest: 'Enable this imported sample skill',
    reason: 'Confirmed useful for explicit invocation',
    operations: [
      {
        op: 'upsert',
        asset: { ...inputOf(current), enabled: true },
        expectedRevision: current.revision,
      },
    ],
  });
  assert.equal(organized.phase, 'organized');
  await call('aacl_onboarding_cutover', { id: discovery.id });
  assert.equal(fs.existsSync(skillPath), false);
  assert.match(fs.readFileSync(path.join(native, 'config.toml'), 'utf8'), /mcp_servers.aacl/);
  assert.equal(
    (
      await call('aacl_asset_file_get', {
        id: assetId,
        path: 'references/check.md',
        revision: asset.revision,
      })
    ).content,
    'SUPPORT_CONTENT',
  );
  await call('aacl_onboarding_restore', { id: discovery.id });
  assert.equal(fs.existsSync(skillPath), true);
  assert.equal(fs.readFileSync(path.join(native, 'config.toml'), 'utf8'), 'model="existing"\n');
  assert.equal(core.state().assets.find((a) => a.id === assetId)!.enabled, false);
  assert.equal((await call('aacl_onboarding_get', { id: discovery.id })).phase, 'restored');
  const auth = {
    userRequest: 'Create two independent rules',
    reason: 'Test history projection',
    actor: { kind: 'user', id: 'test-user' },
  };
  await call('aacl_asset_change', {
    ...auth,
    operations: [
      {
        op: 'upsert',
        asset: { id: 'one', name: 'One', type: 'rule', content: 'ONE_BODY' },
        expectedRevision: 0,
      },
      {
        op: 'upsert',
        asset: { id: 'two', name: 'Two', type: 'rule', content: 'UNRELATED_BODY' },
        expectedRevision: 0,
      },
    ],
  });
  assert.ok(
    !JSON.stringify(await call('aacl_asset_get', { id: 'one' })).includes('UNRELATED_BODY'),
  );
});
