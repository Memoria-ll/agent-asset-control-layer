import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { Core } from '../server/core.ts';
import { Store } from '../server/store.ts';
import { inputOf } from '../server/domain.ts';
import { bootstrap, materialize, onboardingConnectionPlan } from '../server/adapters.ts';
import {
  onboardingDiscover,
  onboardingImport,
  onboardingGet,
  onboardingList,
  onboardingRecordMcpRead,
  onboardingVerify,
  onboardingOrganize,
  onboardingCutover,
  onboardingRestore,
  onboardingPlan,
  onboardingConnect,
  onboardingSchemas,
  type OnboardingManifest,
} from '../server/onboarding.ts';

// Every native runtime root and Core store used here is below a fresh temporary directory.
function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aacl-onboarding-test-'));
  const store = new Store(path.join(dir, 'core'));
  const stores = [store];
  const core = new Core(store);
  const native = path.join(dir, 'native');
  fs.mkdirSync(native);
  t.after(() => {
    stores.forEach((s) => s.close());
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    core,
    store,
    native,
    reopen: () => {
      store.close();
      const next = new Store(store.root);
      stores.push(next);
      return new Core(next);
    },
  };
}
function put(root: string, relative: string, content: string | Buffer) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}
function discover(core: Core, native: string, id?: string) {
  return onboardingDiscover(core, { id, roots: [{ path: native, runtime: 'codex' }] });
}
function verify(core: Core, operation: OnboardingManifest) {
  for (const assetId of operation.selected ?? [])
    onboardingRecordMcpRead(core, {
      assetId,
      revision: core.state().assets.find((a) => a.id === assetId)!.revision,
    });
  return onboardingVerify(
    core,
    { id: operation.id, userRequest: 'Verify the imported assets through MCP' },
    'mcp',
  );
}
function organize(core: Core, operation: OnboardingManifest) {
  return onboardingOrganize(core, {
    id: operation.id,
    userRequest: 'Enable the imported assets for on-demand use',
    reason: 'Keep the native runtime scope',
    classification: review(operation),
    operations: core
      .state()
      .assets.filter((a) => operation.selected?.includes(a.id))
      .map((a) => ({
        op: 'upsert',
        asset: {
          ...inputOf(a),
          type: operation.candidates.find((c) => c.id === a.id)!.type,
          enabled: true,
        },
        expectedRevision: a.revision,
      })),
  });
}
function review(operation: OnboardingManifest) {
  return {
    reviewer: 'fixture-ai-reviewer',
    entries: (operation.selected ?? []).map((sourceId) => ({
      sourceId,
      status: 'classified' as const,
      outputIds: [sourceId],
      reason: 'Reviewed the fixture content and retained its same-worker behavior',
      unconvertedParts: [] as string[],
    })),
  };
}
function ready(core: Core, native: string) {
  const discovered = discover(core, native);
  const imported = onboardingImport(core, { id: discovered.id });
  verify(core, imported);
  return organize(core, imported);
}

function conversion(
  core: Core,
  operation: OnboardingManifest,
  inPlace = false,
): z.input<typeof onboardingSchemas.organize> {
  const source = core.state().assets.find((a) => a.id === operation.selected![0])!;
  const workflowId = inPlace ? source.id : 'converted-workflow';
  return {
    id: operation.id,
    userRequest: 'Convert the reviewed delegation procedure and preserve review rework',
    reason: 'The source mixes delegation, responsibilities, and same-worker checks',
    classification: {
      reviewer: 'fixture-ai-reviewer',
      entries: [
        {
          sourceId: source.id,
          status: 'classified',
          outputIds: [workflowId, 'converted-author', 'converted-reviewer', 'converted-check'],
          reason:
            'Workflow owns delegation and rework; Roles own responsibilities; Skill supplies local checks',
          unconvertedParts: [],
        },
      ],
    },
    operations: [
      ...(!inPlace
        ? [{ op: 'delete' as const, id: source.id, expectedRevision: source.revision }]
        : []),
      {
        op: 'upsert',
        expectedRevision: 0,
        asset: {
          id: 'converted-author',
          type: 'role',
          name: 'Author',
          content: 'Produce the report; apply the checks yourself.',
          dependencies: ['converted-check'],
          role: { responsibilities: ['Write the report'], expectedOutput: ['Report'] },
        },
      },
      {
        op: 'upsert',
        expectedRevision: 0,
        asset: {
          id: 'converted-reviewer',
          type: 'role',
          name: 'Reviewer',
          content: 'Review the report independently.',
          role: { responsibilities: ['Check evidence'], expectedOutput: ['Review findings'] },
        },
      },
      {
        op: 'upsert',
        expectedRevision: 0,
        asset: {
          id: 'converted-check',
          type: 'skill',
          name: 'Local checks',
          content: 'Read references/guide.md and verify the report yourself.',
          files: source.files,
          skill: { expectedOutput: ['Checked report'], completionCriteria: ['Evidence verified'] },
        },
      },
      {
        op: 'upsert',
        expectedRevision: inPlace ? source.revision : 0,
        asset: {
          id: workflowId,
          type: 'workflow',
          name: 'Report workflow',
          content: 'Delegate report writing and review with explicit rework.',
          workflow: {
            developmentCapable: false,
            entryStage: 'author',
            entryRole: 'converted-author',
            completionCriteria: ['Review accepted'],
            stages: [
              {
                id: 'author',
                name: 'Author',
                role: 'converted-author',
                requiredAssets: ['converted-check'],
                expectedOutput: ['Report'],
                transitions: [{ to: 'review', kind: 'advance', requiredArtifacts: ['Report'] }],
              },
              {
                id: 'review',
                name: 'Review',
                role: 'converted-reviewer',
                expectedOutput: ['Review findings'],
                canComplete: true,
                transitions: [
                  { to: 'author', kind: 'return', requiredArtifacts: ['Review findings'] },
                ],
              },
            ],
          },
        },
      },
    ],
  };
}

test('connection retries keep their original targets after creating a default runtime directory', (t) => {
  const { core, dir } = fixture(t);
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
  fs.mkdirSync(path.join(home, '.cursor'));
  const operation = onboardingDiscover(core, { home });
  const request = { id: operation.id, userRequest: 'Connect my runtimes' };
  const connected = onboardingConnect(core, request);
  assert(fs.existsSync(path.join(home, '.codex')));
  const targets = connected.connection!.targets;
  const files = connected.connection!.files.map((file) => fs.readFileSync(file.path, 'utf8'));
  const repeated = onboardingConnect(core, request);
  assert.deepEqual(repeated.connection!.targets, targets);
  assert.deepEqual(
    repeated.connection!.files.map((file) => fs.readFileSync(file.path, 'utf8')),
    files,
  );
});

test('restore preserves a connection shared by later cutovers until dependents are restored', (t) => {
  const { core, dir } = fixture(t);
  const native = path.join(dir, '.codex');
  const firstEntry = put(native, 'skills/first/SKILL.md', 'first skill');
  const first = ready(core, path.dirname(firstEntry));
  onboardingConnect(core, { id: first.id, userRequest: 'Connect first skill' });
  onboardingCutover(core, { id: first.id });
  const nextEntry = put(native, 'skills/next/SKILL.md', 'next skill');
  const next = ready(core, path.dirname(nextEntry));
  const connected = onboardingConnect(core, { id: next.id, userRequest: 'Connect next skill' });
  assert(connected.connection!.files.every((file) => !file.changed));
  onboardingCutover(core, { id: next.id });
  const before = core.state();
  const files = connected.connection!.files.map((file) => fs.readFileSync(file.path, 'utf8'));
  assert.throws(() => onboardingRestore(core, { id: first.id }), { code: 'CONNECTION_IN_USE' });
  assert.deepEqual(core.state(), before);
  assert.equal(onboardingGet(core, { id: first.id }).phase, 'cutover');
  assert(!fs.existsSync(firstEntry));
  assert(!fs.existsSync(nextEntry));
  assert.deepEqual(
    connected.connection!.files.map((file) => fs.readFileSync(file.path, 'utf8')),
    files,
  );
  onboardingRestore(core, { id: next.id });
  assert.equal(fs.readFileSync(nextEntry, 'utf8'), 'next skill');
  assert(connected.connection!.files.every((file) => fs.existsSync(file.path)));
  onboardingRestore(core, { id: first.id });
  assert.equal(fs.readFileSync(firstEntry, 'utf8'), 'first skill');
  assert(connected.connection!.files.every((file) => !fs.existsSync(file.path)));
});

test('a pending connection cannot form a mutual restore dependency with a later operation', (t) => {
  const { core, dir } = fixture(t);
  const native = path.join(dir, '.codex');
  const config = put(native, 'config.toml', 'model = "original"\n');
  const first = discover(core, native, 'pending-first');
  const rename = fs.renameSync;
  const fault = t.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
    if (String(args[1]) === config) throw new Error('interrupted before replacement');
    return rename(...args);
  });
  assert.throws(
    () => onboardingConnect(core, { id: first.id, userRequest: 'Connect first' }),
    /interrupted/,
  );
  fault.mock.restore();
  assert.equal(onboardingGet(core, { id: first.id }).connection!.phase, 'installing');
  const next = discover(core, native, 'pending-next');
  const request = { id: next.id, userRequest: 'Connect next' };
  assert.throws(() => onboardingConnect(core, request), { code: 'CONNECTION_BUSY' });
  assert.equal(fs.readFileSync(config, 'utf8'), 'model = "original"\n');
  assert.equal(onboardingRestore(core, { id: first.id }).connection!.phase, 'restored');
  assert.equal(onboardingConnect(core, request).connection!.phase, 'installed');
  assert.equal(onboardingRestore(core, { id: next.id }).connection!.phase, 'restored');
  assert.equal(fs.readFileSync(config, 'utf8'), 'model = "original"\n');
});

test('discovery uses local host, default roots, deterministic identities and metadata-only manifests', (t) => {
  const { core, dir } = fixture(t);
  const home = path.join(dir, 'home');
  put(home, '.codex/skills/same/SKILL.md', 'SECRET_ASSET_BODY_A');
  put(home, '.claude/skills/same/SKILL.md', 'SECRET_ASSET_BODY_B');
  put(home, '.cursor/rules/project.mdc', 'cursor rule');
  put(home, '.agents/skills/shared/SKILL.md', 'shared skill');
  put(home, '.codex/auth.json', 'AUTH_SENTINEL');
  put(home, '.claude/settings.json', 'SETTINGS_SENTINEL');
  put(home, '.cursor/extensions/package.md', 'EXTENSION_SENTINEL');
  put(home, '.codex/plugins/skills/managed/SKILL.md', 'PLUGIN_SENTINEL');
  const result = onboardingDiscover(core, { home });
  assert.equal(result.candidates.length, 4);
  assert.equal(new Set(result.candidates.map((c) => c.id)).size, 4);
  assert.equal(result.candidates.filter((c) => c.name === 'same').length, 2);
  assert.equal(result.host, os.hostname());
  assert(result.issues.some((i) => i.code === 'PLUGIN_MANAGED_UNSUPPORTED'));
  const repeated = onboardingDiscover(core, { home });
  assert.equal(repeated.id, result.id);
  assert.equal(onboardingList(core).length, 1);
  const manifest = fs.readFileSync(
    path.join(core.store.root, 'onboarding', result.id, 'manifest.json'),
    'utf8',
  );
  for (const secret of [
    'SECRET_ASSET_BODY',
    'AUTH_SENTINEL',
    'SETTINGS_SENTINEL',
    'EXTENSION_SENTINEL',
    'PLUGIN_SENTINEL',
  ]) {
    assert(!manifest.includes(secret));
    assert(!JSON.stringify(result).includes(secret));
  }
});

test('bundles import from backups, preserve relative references and export into another empty project', (t) => {
  const { core, native, dir } = fixture(t);
  const content =
    '---\nname: checker\ndescription: Check a change\n---\nRead references/checklist.md and scripts/check.py.\n';
  put(native, 'skills/checker/SKILL.md', content);
  put(native, 'skills/checker/references/checklist.md', 'check all cases\n');
  const script = put(native, 'skills/checker/scripts/check.py', 'print("checked")\n');
  fs.chmodSync(script, 0o755);
  put(native, 'AGENTS.md', 'project rules\n');
  put(native, 'prompts/explain.md', 'unclassified instructions\n');
  const projectRoot = path.join(dir, 'project');
  fs.mkdirSync(projectRoot);
  const project = core.initProject({ root: projectRoot, name: 'test project' });
  const discovered = onboardingDiscover(core, {
    roots: [{ path: native, runtime: 'codex', projectId: project.id }],
  });
  const result = onboardingImport(core, { id: discovered.id });
  assert.equal(result.phase, 'imported');
  assert(result.candidates.every((c) => c.files.every((f) => f.backedUp)));
  assert.equal(fs.readFileSync(path.join(native, 'skills/checker/SKILL.md'), 'utf8'), content);
  const assets = core.state().assets;
  assert.equal(assets.length, 3);
  assert(result.classificationRequired);
  assert(assets.every((a) => a.type === 'other' && !a.enabled));
  const skill = assets.find((a) => a.name === 'checker')!;
  assert.equal(skill.name, 'checker');
  assert.equal(skill.content, content);
  assert.equal(skill.files?.['references/checklist.md'], 'check all cases\n');
  assert.equal(skill.sources?.[0].host, os.hostname());
  assert.equal(skill.sources?.[0].path, path.join(native, 'skills/checker/SKILL.md'));
  assert.equal(skill.sources?.[0].hash, result.candidates.find((c) => c.id === skill.id)!.hash);
  assert.equal(skill.enabled, false);
  assert.deepEqual(skill.scope, { project: [project.id], runtime: ['codex'] });
  assert.deepEqual(onboardingImport(core, { id: result.id }).selected, result.selected);
  assert.equal(core.state().assets.length, 3);
  verify(core, result);
  organize(core, result);
  const reviewed = core.state().assets.find((a) => a.id === skill.id)!;
  assert.equal(reviewed.type, 'skill');
  // User explicitly makes the reviewed skill portable; export to an empty project.
  core.changeAssets({
    summary: 'make skill portable',
    operations: [
      {
        op: 'upsert',
        asset: { ...inputOf(reviewed), enabled: true, projectId: undefined, scope: {} },
        expectedRevision: reviewed.revision,
      },
    ],
  });
  const output = materialize(core, { runtime: 'claude', requested: [skill.id] });
  const exportedRoot = path.join(dir, 'empty-project');
  for (const file of output.files) put(exportedRoot, file.path, file.content);
  const entry = path.join(exportedRoot, '.claude/skills', skill.id, 'SKILL.md');
  assert.equal(fs.readFileSync(entry, 'utf8'), content);
  assert.equal(
    fs.readFileSync(path.join(path.dirname(entry), 'references/checklist.md'), 'utf8'),
    'check all cases\n',
  );
  assert.equal(
    fs.readFileSync(path.join(path.dirname(entry), 'scripts/check.py'), 'utf8'),
    'print("checked")\n',
  );
});

test('MCP read and revisioned write proof gates organization and cutover across actual protocol calls', async (t) => {
  const { core, native } = fixture(t);
  put(native, 'skills/a/SKILL.md', 'read me');
  const operation = onboardingImport(core, { id: discover(core, native).id });
  assert.throws(
    () => onboardingVerify(core, { id: operation.id, userRequest: 'verify' }),
    /MCP handler/,
  );
  assert.throws(() =>
    onboardingVerify(core, { id: operation.id, userRequest: 'verify', transport: 'mcp' }, 'mcp'),
  );
  assert.throws(
    () => onboardingVerify(core, { id: operation.id, userRequest: 'verify' }, 'mcp'),
    /Retrieve every/,
  );
  assert.throws(() => organize(core, operation), /Verify MCP/);
  assert.throws(
    () => onboardingCutover(core, { id: operation.id }),
    /verification and organization/,
  );
  const server = new McpServer({ name: 'onboarding-proof-test', version: '1' });
  server.registerTool('asset_get', { inputSchema: { id: z.string() } }, async ({ id }) => {
    const asset = core.state().assets.find((a) => a.id === id)!;
    const result = { content: [{ type: 'text' as const, text: JSON.stringify({ asset }) }] };
    onboardingRecordMcpRead(core, { assetId: id, revision: asset.revision });
    return result;
  });
  server.registerTool(
    'verify',
    { inputSchema: { id: z.string(), userRequest: z.string() } },
    async (input) => ({
      content: [
        { type: 'text' as const, text: JSON.stringify(onboardingVerify(core, input, 'mcp')) },
      ],
    }),
  );
  const client = new Client({ name: 'native-runtime-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  for (const id of operation.selected!) {
    const result = await client.callTool({ name: 'asset_get', arguments: { id } });
    assert(!result.isError);
  }
  const revision = core.state().assets[0].revision;
  const result = await client.callTool({
    name: 'verify',
    arguments: { id: operation.id, userRequest: 'Verify the MCP connection' },
  });
  assert(!result.isError);
  const verified = onboardingGet(core, { id: operation.id });
  assert.equal(verified.phase, 'verified');
  assert.equal(core.state().assets[0].revision, revision + 1);
  assert(core.state().state.changesets.some((c) => c.id === verified.verification?.changeSetId));
  assert.equal(core.state().state.journals.length, 0);
  organize(core, verified);
  onboardingCutover(core, { id: operation.id });
  assert(!fs.existsSync(path.join(native, 'skills/a/SKILL.md')));
});

test('full lifecycle resumes after restart and restores native bytes and organization through Core rollback', (t) => {
  const { core, native, reopen } = fixture(t);
  put(native, 'skills/a/SKILL.md', 'run scripts/a.sh\n');
  const helper = put(native, 'skills/a/scripts/a.sh', '#!/bin/sh\necho ok\n');
  fs.chmodSync(helper, 0o755);
  put(native, 'rules/a.md', 'a native rule');
  const auth = put(native, 'auth.json', 'keep auth');
  const config = put(native, 'config.toml', 'keep config');
  const plugin = put(native, 'plugins/x/SKILL.md', 'keep plugin');
  const operation = ready(core, native);
  const changeSetId = operation.organization!.changeSetId;
  const cut = onboardingCutover(core, { id: operation.id });
  assert.equal(cut.phase, 'cutover');
  assert.equal(onboardingCutover(core, { id: operation.id }).phase, 'cutover');
  assert.equal(fs.readFileSync(auth, 'utf8'), 'keep auth');
  assert.equal(fs.readFileSync(config, 'utf8'), 'keep config');
  assert.equal(fs.readFileSync(plugin, 'utf8'), 'keep plugin');
  const restarted = reopen();
  assert.equal(onboardingGet(restarted, { id: operation.id }).phase, 'cutover');
  const restored = onboardingRestore(restarted, { id: operation.id });
  assert.equal(restored.phase, 'restored');
  assert.equal(fs.readFileSync(helper, 'utf8'), '#!/bin/sh\necho ok\n');
  assert.equal(fs.statSync(helper).mode & 0o777, 0o755);
  assert.equal(
    fs.readFileSync(path.join(native, 'skills/a/SKILL.md'), 'utf8'),
    'run scripts/a.sh\n',
  );
  assert(restarted.state().assets.every((a) => !a.enabled));
  assert(restarted.state().state.changesets.some((c) => c.rollbackOf === changeSetId));
  assert.equal(onboardingRestore(restarted, { id: operation.id }).phase, 'restored');
});

test('discovery rejects unsafe roots, unsupported bundle members, binary files and bounded sizes', (t) => {
  const { core, native, dir } = fixture(t);
  const outside = put(dir, 'outside.md', 'outside content');
  put(native, 'skills/link/SKILL.md', 'unsafe reference');
  fs.symlinkSync(outside, path.join(native, 'skills/link/reference.md'));
  put(native, 'skills/large/SKILL.md', 'large helper');
  put(native, 'skills/large/data.txt', 'x'.repeat(200001));
  put(native, 'skills/binary/SKILL.md', 'binary helper');
  put(native, 'skills/binary/data.png', Buffer.from([0xff, 0, 1]));
  put(native, 'skills/private/SKILL.md', 'has private file');
  put(native, 'skills/private/.env', 'TOKEN=secret');
  put(native, 'skills/device/SKILL.md', 'reserved path');
  put(native, 'skills/device/CON.txt', 'device');
  const operation = discover(core, native);
  assert.equal(operation.candidates.length, 5);
  assert(operation.candidates.every((c) => c.blocked));
  assert(operation.issues.some((i) => i.code === 'FILE_TOO_LARGE'));
  assert(operation.issues.some((i) => i.code === 'UNSAFE_PATH'));
  assert(operation.issues.some((i) => i.code === 'UNSUPPORTED_ENCODING'));
  assert.throws(() => onboardingImport(core, { id: operation.id }), /supported discovered/);
  assert.throws(() =>
    onboardingDiscover(core, { roots: [{ path: `${native}/../native`, runtime: 'other' }] }),
  );
  assert.throws(
    () =>
      onboardingDiscover(core, {
        roots: [{ path: native, host: 'remote-host', runtime: 'other' }],
      }),
    /local host/,
  );
  assert.throws(
    () => onboardingDiscover(core, { roots: [{ path: core.store.root, runtime: 'other' }] }),
    /overlap/,
  );
  const linkRoot = path.join(dir, 'link-root');
  fs.symlinkSync(native, linkRoot);
  assert.equal(discover(core, linkRoot).candidates.length, 0);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside content');
});

test('explicit roots inside private and plugin-managed directories do not bypass exclusions', (t) => {
  const { core, dir } = fixture(t);
  const home = path.join(dir, 'home');
  put(home, '.codex/plugins/pkg/skills/s/SKILL.md', 'managed');
  put(home, '.codex/sessions/session.md', 'private history');
  for (const relative of ['.codex/plugins/pkg/skills/s', '.codex/sessions/session.md']) {
    const operation = discover(core, path.join(home, relative));
    assert.equal(operation.candidates.length, 0);
    assert(operation.issues.some((i) => i.code === 'EXCLUDED_PATH'));
  }
});

test('pre-existing backup files are never overwritten and source changes stop import', (t) => {
  const { core, native } = fixture(t);
  const source = put(native, 'skills/a/SKILL.md', 'original');
  const operation = discover(core, native);
  const candidate = operation.candidates[0];
  const backup = put(
    path.join(core.store.root, 'onboarding', operation.id, 'backup', candidate.id),
    'SKILL.md',
    'collision',
  );
  assert.throws(() => onboardingImport(core, { id: operation.id }), /Backup hash/);
  assert.equal(fs.readFileSync(backup, 'utf8'), 'collision');
  assert.equal(core.state().assets.length, 0);
  assert.equal(fs.readFileSync(source, 'utf8'), 'original');
  const second = discover(core, native, 'second-attempt');
  fs.writeFileSync(source, 'edited since discovery');
  assert.throws(() => onboardingImport(core, { id: second.id }), /source file changed/);
  assert.equal(core.state().assets.length, 0);
});

test('interrupted Core import and organization commits are recovered without duplicate revisions', (t) => {
  const { core, native } = fixture(t);
  put(native, 'skills/a/SKILL.md', 'original');
  const operation = discover(core, native);
  const originalChange = core.changeAssets.bind(core);
  let fail = true;
  const mock = t.mock.method(core, 'changeAssets', (input: unknown) => {
    const result = originalChange(input);
    if (fail) {
      fail = false;
      throw new Error('simulate crash after Core commit');
    }
    return result;
  });
  assert.throws(() => onboardingImport(core, { id: operation.id }), /simulate crash/);
  const imported = onboardingImport(core, { id: operation.id });
  assert.equal(core.state().assets[0].revision, 1);
  assert.equal(imported.phase, 'imported');
  verify(core, imported);
  const asset = core.state().assets[0];
  const request = {
    id: operation.id,
    userRequest: 'Classify this asset',
    reason: 'Explicit scope',
    classification: review(imported),
    operations: [
      {
        op: 'upsert',
        asset: { ...inputOf(asset), enabled: true },
        expectedRevision: asset.revision,
      },
    ],
  };
  fail = true;
  assert.throws(() => onboardingOrganize(core, request), /simulate crash/);
  const revision = core.state().assets[0].revision;
  const organized = onboardingOrganize(core, request);
  assert.equal(organized.phase, 'organized');
  assert.equal(core.state().assets[0].revision, revision);
  assert.equal(core.state().state.journals.length, 0);
  assert.throws(
    () => onboardingOrganize(core, { ...request, reason: 'different request' }),
    /another organization/,
  );
  mock.mock.restore();
});

test('cutover preflights all sources and blocks stale canonical revisions before deleting anything', (t) => {
  const { core, native } = fixture(t);
  const first = put(native, 'rules/a.md', 'first');
  const second = put(native, 'rules/b.md', 'second');
  const operation = ready(core, native);
  fs.writeFileSync(second, 'later edit');
  assert.throws(() => onboardingCutover(core, { id: operation.id }), /source file changed/);
  assert.equal(fs.readFileSync(first, 'utf8'), 'first');
  fs.writeFileSync(second, 'second');
  const asset = core.state().assets[0];
  core.changeAssets({
    summary: 'later canonical edit',
    operations: [
      {
        op: 'upsert',
        asset: { ...inputOf(asset), content: 'new canonical content' },
        expectedRevision: asset.revision,
      },
    ],
  });
  assert.throws(() => onboardingCutover(core, { id: operation.id }), /changed after organization/);
  assert.equal(fs.readFileSync(first, 'utf8'), 'first');
});

test('interrupted file removal resumes and later native edits block restore without overwrite', (t) => {
  const { core, native } = fixture(t);
  const entry = put(native, 'skills/a/SKILL.md', 'read helper.md');
  const helper = put(native, 'skills/a/helper.md', 'original helper');
  const operation = ready(core, native);
  const originalUnlink = fs.unlinkSync;
  let removed = false;
  const mock = t.mock.method(fs, 'unlinkSync', (file: fs.PathLike) => {
    if (String(file) === helper && removed) throw new Error('interrupted removal');
    originalUnlink(file);
    if (String(file) === entry) removed = true;
  });
  assert.throws(() => onboardingCutover(core, { id: operation.id }), /interrupted removal/);
  assert(!fs.existsSync(entry));
  assert(fs.existsSync(helper));
  assert.equal(onboardingGet(core, { id: operation.id }).phase, 'cutting-over');
  mock.mock.restore();
  assert.equal(onboardingCutover(core, { id: operation.id }).phase, 'cutover');
  put(native, 'skills/a/helper.md', 'new user content');
  assert.throws(() => onboardingRestore(core, { id: operation.id }), /source file changed/);
  assert.equal(fs.readFileSync(helper, 'utf8'), 'new user content');
  assert(!fs.existsSync(entry));
});

test('source and backup symlink substitution is rejected during import, cutover and restore', (t) => {
  const { core, native, dir } = fixture(t);
  const source = put(native, 'skills/a/SKILL.md', 'original');
  const outside = put(dir, 'outside.md', 'original');
  const operation = discover(core, native);
  fs.unlinkSync(source);
  fs.symlinkSync(outside, source);
  assert.throws(() => onboardingImport(core, { id: operation.id }), /Symbolic links/);
  fs.unlinkSync(source);
  put(native, 'skills/a/SKILL.md', 'original');
  const imported = onboardingImport(core, { id: operation.id });
  verify(core, imported);
  organize(core, imported);
  const backup = path.join(
    core.store.root,
    'onboarding',
    operation.id,
    'backup',
    operation.candidates[0].id,
    'SKILL.md',
  );
  fs.unlinkSync(backup);
  fs.symlinkSync(outside, backup);
  assert.throws(() => onboardingCutover(core, { id: operation.id }), /Symbolic links/);
  assert.throws(() => onboardingRestore(core, { id: operation.id }), /Symbolic links/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'original');
  assert.equal(fs.readFileSync(source, 'utf8'), 'original');
});

test('connection plans leave credentials and native configuration untouched and bootstrap describes real events', (t) => {
  const { core, native } = fixture(t);
  const config = put(native, 'config.toml', 'original configuration');
  const operation = discover(core, native);
  assert.equal(onboardingPlan(core, { id: operation.id }).plans.length, 1);
  for (const runtime of ['codex', 'claude', 'cursor', 'other']) {
    const plan = onboardingConnectionPlan({ runtime, endpoint: 'http://localhost:4780/mcp' });
    assert.equal(plan.connection.automatic, runtime !== 'other');
    assert(plan.files.some((f) => f.path === 'AACL-BOOTSTRAP.md'));
    assert(plan.files.some((f) => f.content.includes('http://localhost:4780/mcp')));
  }
  assert.throws(
    () =>
      onboardingConnectionPlan({ runtime: 'codex', endpoint: 'https://user:password@host/mcp' }),
    /without credentials/,
  );
  assert.throws(
    () =>
      onboardingConnectionPlan({ runtime: 'claude', endpoint: 'https://host/mcp?token=secret' }),
    /without credentials/,
  );
  assert.equal(fs.readFileSync(config, 'utf8'), 'original configuration');
  const contract = bootstrap();
  for (const term of [
    'userRequest',
    'aacl_run_get',
    'started',
    'result',
    'failed',
    'not evidence',
    'Do not fabricate',
  ])
    assert(contract.includes(term));
  assert(!contract.includes('Human approval happens in the Core UI'));
});

test('reviewed classification resolves forward relative skill links from source entry files', (t) => {
  const { core, native } = fixture(t);
  put(native, 'skills/a/SKILL.md', 'See [B](../b/SKILL.md).');
  put(native, 'skills/b/SKILL.md', 'B provides background.');
  const imported = onboardingImport(core, { id: discover(core, native).id });
  assert(core.state().assets.every((a) => a.type === 'other'));
  verify(core, imported);
  organize(core, imported);
  const a = core.state().assets.find((a) => a.name === 'a')!;
  const b = core.state().assets.find((a) => a.name === 'b')!;
  assert.equal(a.sources?.[0].path, path.join(native, 'skills/a/SKILL.md'));
  assert(
    a.relations?.some(
      (r) => r.target === b.id && r.kind === 'reference' && r.origin === 'extracted',
    ),
  );
  assert.equal(new Set(imported.candidates.map((c) => c.importChangeSetId)).size, 1);
});

test('restore after interruption resumes helpers before entry points and reimport keeps deterministic IDs', (t) => {
  const { core, native } = fixture(t);
  const entry = put(native, 'skills/a/SKILL.md', 'read helper.md');
  const helper = put(native, 'skills/a/helper.md', 'helper');
  const operation = ready(core, native);
  onboardingCutover(core, { id: operation.id });
  const originalOpen = fs.openSync;
  const mock = t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]) === entry && typeof args[1] === 'number' && args[1] & fs.constants.O_CREAT)
      throw new Error('interrupted restore');
    return originalOpen(...args);
  });
  assert.throws(() => onboardingRestore(core, { id: operation.id }), /interrupted restore/);
  assert.equal(onboardingGet(core, { id: operation.id }).phase, 'restoring');
  assert(fs.existsSync(helper));
  assert(!fs.existsSync(entry));
  mock.mock.restore();
  assert.equal(onboardingRestore(core, { id: operation.id }).phase, 'restored');
  const before = core.state().assets.map((a) => ({ id: a.id, revision: a.revision }));
  const again = discover(core, native, 'explicit-reimport');
  onboardingImport(core, { id: again.id });
  assert.deepEqual(
    core.state().assets.map((a) => ({ id: a.id, revision: a.revision })),
    before,
  );
  assert.deepEqual(
    again.candidates.map((c) => c.id),
    operation.candidates.map((c) => c.id),
  );
  assert.equal(onboardingImport(core, { id: operation.id }).phase, 'restored');
});

test('new skill members and stale MCP reads cannot silently pass safety gates', (t) => {
  const { core, native } = fixture(t);
  put(native, 'skills/a/SKILL.md', 'read helper.md');
  put(native, 'skills/a/helper.md', 'helper');
  const operation = onboardingImport(core, { id: discover(core, native).id });
  const asset = core.state().assets[0];
  assert.throws(
    () => onboardingRecordMcpRead(core, { assetId: asset.id, revision: asset.revision + 1 }),
    /no longer current/,
  );
  verify(core, operation);
  organize(core, operation);
  put(native, 'skills/a/new-file.md', 'new native material');
  assert.throws(() => onboardingCutover(core, { id: operation.id }), /New files/);
  assert(fs.existsSync(path.join(native, 'skills/a/SKILL.md')));
});

test('restore preserves subsequent canonical organization edits and unknown runtimes cannot cut over', (t) => {
  const { core, native } = fixture(t);
  const source = put(native, 'rules/a.md', 'rule');
  const operation = ready(core, native);
  const asset = core.state().assets[0];
  core.changeAssets({
    summary: 'later authorized edit',
    operations: [
      {
        op: 'upsert',
        asset: { ...inputOf(asset), description: 'preserve this' },
        expectedRevision: asset.revision,
      },
    ],
  });
  assert.throws(() => onboardingRestore(core, { id: operation.id }), { code: 'ASSET_CHANGED' });
  assert.equal(core.state().assets[0].description, 'preserve this');
  assert.equal(fs.readFileSync(source, 'utf8'), 'rule');
  const otherRoot = path.join(native, 'other');
  put(otherRoot, 'note.md', 'other runtime instructions');
  const unknown = onboardingDiscover(core, {
    id: 'other-runtime',
    roots: [{ path: otherRoot, runtime: 'other' }],
  });
  const imported = onboardingImport(core, { id: unknown.id });
  verify(core, imported);
  onboardingOrganize(core, {
    id: unknown.id,
    userRequest: 'Keep current organization',
    reason: 'Already classified',
    classification: review(imported),
    operations: [],
  });
  assert.throws(
    () => onboardingCutover(core, { id: unknown.id }),
    /explicit native loading adapter/,
  );
  assert.equal(onboardingPlan(core, { id: unknown.id }).plans[0].cutover.supported, false);
});

test('AI review must cover every selected source and uncertain content remains provisional', (t) => {
  const { core, native } = fixture(t);
  const content = 'Delegate a report to another worker. This may instead be a quoted example.';
  const entry = put(native, 'skills/mixed/SKILL.md', content);
  put(native, 'rules/check.md', 'Check the result yourself.');
  const imported = onboardingImport(core, { id: discover(core, native).id });
  assert.equal(imported.classificationRequired, true);
  assert(core.state().assets.every((a) => a.type === 'other' && !a.enabled));
  verify(core, imported);
  const classification = review(imported);
  const request = {
    id: imported.id,
    userRequest: 'Review all imported content',
    reason: 'Resolve ambiguous instructions',
    classification,
    operations: [],
  };
  const before = core.state();
  assert.throws(() => onboardingOrganize(core, { ...request, classification: undefined }));
  assert.throws(
    () =>
      onboardingOrganize(core, {
        ...request,
        classification: { ...classification, entries: classification.entries.slice(0, 1) },
      }),
    { code: 'CLASSIFICATION_COVERAGE' },
  );
  assert.throws(
    () =>
      onboardingOrganize(core, {
        ...request,
        classification: {
          ...classification,
          entries: [classification.entries[0], classification.entries[0]],
        },
      }),
    { code: 'CLASSIFICATION_COVERAGE' },
  );
  assert.deepEqual(core.state(), before);
  const uncertain = {
    ...classification,
    entries: classification.entries.map((e) => ({
      ...e,
      status: 'uncertain',
      unconvertedParts: ['Determine whether the delegation is an instruction or an output example'],
    })),
  };
  const source = core.state().assets[0];
  assert.throws(
    () =>
      onboardingOrganize(core, {
        ...request,
        classification: uncertain,
        operations: [
          {
            op: 'upsert',
            asset: { ...inputOf(source), enabled: true },
            expectedRevision: source.revision,
          },
        ],
      }),
    { code: 'UNCERTAIN_CLASSIFICATION' },
  );
  const organized = onboardingOrganize(core, { ...request, classification: uncertain });
  assert.deepEqual(organized.organization?.classification, uncertain);
  assert(core.state().assets.every((a) => !a.enabled && a.type === 'other'));
  assert.throws(() => onboardingCutover(core, { id: imported.id }), {
    code: 'CLASSIFICATION_INCOMPLETE',
  });
  assert.equal(fs.readFileSync(entry, 'utf8'), content);
  assert.equal(onboardingRestore(core, { id: imported.id }).phase, 'restored');
});

test('one reviewed source becomes Workflow, Roles and Skill in one reversible batch', (t) => {
  const { core, native, dir, reopen } = fixture(t);
  const text =
    'Delegate authoring, wait for independent review, return findings to the author, then finish.';
  const entry = put(native, 'skills/mixed/SKILL.md', text);
  put(native, 'skills/mixed/references/guide.md', 'Evidence checklist');
  const projectRoot = path.join(dir, 'project');
  fs.mkdirSync(projectRoot);
  const project = core.initProject({ root: projectRoot, name: 'Scoped conversion' });
  const discovered = onboardingDiscover(core, {
    roots: [{ path: native, runtime: 'codex', projectId: project.id }],
  });
  const imported = onboardingImport(core, { id: discovered.id });
  verify(core, imported);
  const source = core.state().assets[0];
  const request = conversion(core, imported);
  const beforeChanges = core.state().state.changesets.length;
  const organized = onboardingOrganize(core, request);
  assert.equal(core.state().state.changesets.length, beforeChanges + 1);
  assert.equal(core.state().assets.length, 4);
  assert(!core.state().assets.some((a) => a.id === source.id));
  assert.deepEqual(organized.organization!.absent, [source.id]);
  assert.deepEqual(
    new Set(organized.organization!.assets.map((a) => a.id)),
    new Set(request.classification.entries[0].outputIds),
  );
  for (const asset of core.state().assets) {
    assert.deepEqual(asset.sources, source.sources);
    assert.deepEqual(asset.scope, source.scope);
    assert.equal(asset.projectId, project.id);
  }
  assert.equal(
    core.state().assets.find((a) => a.type === 'skill')!.files?.['references/guide.md'],
    'Evidence checklist',
  );
  const workflow = core.state().assets.find((a) => a.type === 'workflow')!.workflow!;
  assert.deepEqual(workflow.stages[1].transitions, [
    { to: 'author', kind: 'return', requiredArtifacts: ['Review findings'] },
  ]);
  assert.deepEqual(workflow.stages[0].expectedOutput, ['Report']);
  const manifestText = fs.readFileSync(
    path.join(core.store.root, 'onboarding', imported.id, 'manifest.json'),
    'utf8',
  );
  assert(!manifestText.includes(text));
  const restarted = reopen();
  assert.equal(onboardingCutover(restarted, { id: imported.id }).phase, 'cutover');
  assert(!fs.existsSync(entry));
  assert.throws(
    () => onboardingRestore(restarted, { id: imported.id, rollbackOrganization: false }),
    { code: 'ORGANIZATION_ROLLBACK_REQUIRED' },
  );
  const restored = onboardingRestore(restarted, { id: imported.id });
  assert(restored.rollbackChangeSetId);
  assert.equal(fs.readFileSync(entry, 'utf8'), text);
  assert.equal(restarted.state().assets.length, 1);
  const original = restarted.state().assets[0];
  assert.equal(original.id, source.id);
  assert.equal(original.type, 'other');
  assert.equal(original.enabled, false);
  assert.deepEqual(inputOf(original), inputOf(source));
  const reimport = onboardingDiscover(restarted, {
    id: 'converted-reimport',
    roots: [{ path: native, runtime: 'codex', projectId: project.id }],
  });
  const revision = original.revision;
  onboardingImport(restarted, { id: reimport.id });
  assert.equal(restarted.state().assets.length, 1);
  assert.equal(restarted.state().assets[0].revision, revision);
});

test('review may transform the original ID into a Workflow without retaining orchestration as a Skill', (t) => {
  const { core, native } = fixture(t);
  put(native, 'skills/mixed/SKILL.md', 'Delegate and review.');
  const imported = onboardingImport(core, { id: discover(core, native).id });
  verify(core, imported);
  const id = imported.selected![0];
  const organized = onboardingOrganize(core, conversion(core, imported, true));
  assert.equal(core.state().assets.find((a) => a.id === id)!.type, 'workflow');
  assert.deepEqual(organized.organization!.absent, []);
  onboardingCutover(core, { id: imported.id });
  onboardingRestore(core, { id: imported.id });
  assert.equal(core.state().assets.length, 1);
  assert.equal(core.state().assets[0].id, id);
  assert.equal(core.state().assets[0].enabled, false);
});

test('conversion rejects scope loss, uncovered outputs, duplicate activation and invalid references atomically', (t) => {
  const { core, native } = fixture(t);
  put(native, 'skills/mixed/SKILL.md', 'Delegate and review.');
  const imported = onboardingImport(core, { id: discover(core, native).id });
  verify(core, imported);
  const source = core.state().assets[0];
  const request = conversion(core, imported);
  const before = core.state();
  const wrongScope = structuredClone(request);
  const output = wrongScope.operations.find((op) => op.op === 'upsert')!;
  if (output.op === 'upsert') output.asset.scope = { runtime: ['claude'] };
  assert.throws(() => onboardingOrganize(core, wrongScope), { code: 'SOURCE_SCOPE_CHANGED' });
  const undeclared = structuredClone(request);
  undeclared.operations.push({
    op: 'upsert',
    expectedRevision: 0,
    asset: { id: 'unreviewed-output', type: 'rule', name: 'unreviewed' },
  });
  assert.throws(() => onboardingOrganize(core, undeclared), { code: 'CLASSIFICATION_COVERAGE' });
  const duplicate = structuredClone(request);
  duplicate.operations[0] = {
    op: 'upsert',
    expectedRevision: source.revision,
    asset: { ...inputOf(source), enabled: true },
  };
  assert.throws(() => onboardingOrganize(core, duplicate), { code: 'ORIGINAL_STILL_ACTIVE' });
  duplicate.classification.entries[0].outputIds.push(source.id);
  assert.throws(() => onboardingOrganize(core, duplicate), { code: 'ORIGINAL_STILL_ACTIVE' });
  const invalid = structuredClone(request);
  const flow = invalid.operations.find((op) => op.op === 'upsert' && op.asset.type === 'workflow')!;
  if (flow.op === 'upsert') flow.asset.workflow!.stages[0].requiredAssets = ['missing-skill'];
  assert.throws(() => onboardingOrganize(core, invalid));
  assert.deepEqual(core.state(), before);
  assert.equal(onboardingGet(core, { id: imported.id }).phase, 'verified');
  assert(fs.existsSync(path.join(native, 'skills/mixed/SKILL.md')));
});

test('unconverted portions are reported and block native cutover even for classified outputs', (t) => {
  const { core, native } = fixture(t);
  const entry = put(
    native,
    'skills/mixed/SKILL.md',
    'Delegate; legacy external rework trigger is unclear.',
  );
  const imported = onboardingImport(core, { id: discover(core, native).id });
  verify(core, imported);
  const request = conversion(core, imported);
  request.classification.entries[0].unconvertedParts = ['Legacy external rework trigger'];
  const organized = onboardingOrganize(core, request);
  assert.deepEqual(organized.organization!.classification!.entries[0].unconvertedParts, [
    'Legacy external rework trigger',
  ]);
  assert.throws(() => onboardingCutover(core, { id: imported.id }), {
    code: 'CLASSIFICATION_INCOMPLETE',
  });
  assert(fs.existsSync(entry));
  onboardingRestore(core, { id: imported.id });
  assert(core.state().assets.every((a) => !a.enabled));
});

test('interrupted conversion recovers deleted originals and output stamps without absorbing later edits', (t) => {
  const { core, native } = fixture(t);
  const entry = put(native, 'skills/mixed/SKILL.md', 'Delegate and review.');
  const imported = onboardingImport(core, { id: discover(core, native).id });
  verify(core, imported);
  const request = conversion(core, imported);
  const changeAssets = core.changeAssets.bind(core);
  const mock = t.mock.method(core, 'changeAssets', (input: unknown) => {
    changeAssets(input);
    throw new Error('crash after conversion commit');
  });
  assert.throws(() => onboardingOrganize(core, request), /crash after conversion/);
  mock.mock.restore();
  const before = core.state();
  const flow = before.assets.find((a) => a.type === 'workflow')!;
  core.changeAssets({
    summary: 'later user edit',
    operations: [
      {
        op: 'upsert',
        expectedRevision: flow.revision,
        asset: { ...inputOf(flow), description: 'Do not roll this back' },
      },
    ],
  });
  const organized = onboardingOrganize(core, request);
  assert.equal(
    organized.organization!.assets.find((a) => a.id === flow.id)!.revision,
    flow.revision,
  );
  assert.equal(core.state().state.changesets.length, before.state.changesets.length + 1);
  assert.deepEqual(organized.organization!.absent, imported.selected);
  assert.throws(() => onboardingCutover(core, { id: imported.id }), { code: 'ASSET_CHANGED' });
  assert.throws(() => onboardingRestore(core, { id: imported.id }), { code: 'ASSET_CHANGED' });
  assert.equal(
    core.state().assets.find((a) => a.id === flow.id)!.description,
    'Do not roll this back',
  );
  assert(fs.existsSync(entry));
});

test('cutover and restore reject recreated originals and interrupted restore rejects recreated outputs', (t) => {
  const { core, native } = fixture(t);
  const entry = put(native, 'skills/mixed/SKILL.md', 'Delegate and review.');
  const imported = onboardingImport(core, { id: discover(core, native).id });
  verify(core, imported);
  const source = core.state().assets[0];
  onboardingOrganize(core, conversion(core, imported));
  core.changeAssets({
    summary: 'restore original independently',
    operations: [{ op: 'upsert', expectedRevision: 0, asset: inputOf(source) }],
  });
  assert.throws(() => onboardingCutover(core, { id: imported.id }), { code: 'ASSET_CHANGED' });
  assert.throws(() => onboardingRestore(core, { id: imported.id }), { code: 'ASSET_CHANGED' });
  assert(fs.existsSync(entry));
  const recreated = core.state().assets.find((a) => a.id === source.id)!;
  core.changeAssets({
    summary: 'remove independently restored original',
    operations: [{ op: 'delete', id: source.id, expectedRevision: recreated.revision }],
  });
  onboardingCutover(core, { id: imported.id });
  const output = core.state().assets.find((a) => a.type === 'skill')!;
  const openSync = fs.openSync;
  const mock = t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]) === entry && typeof args[1] === 'number' && args[1] & fs.constants.O_CREAT)
      throw new Error('interrupted native restore');
    return openSync(...args);
  });
  assert.throws(() => onboardingRestore(core, { id: imported.id }), /interrupted native restore/);
  mock.mock.restore();
  assert(!fs.existsSync(entry));
  core.changeAssets({
    summary: 'independent output creation',
    operations: [{ op: 'upsert', expectedRevision: 0, asset: inputOf(output) }],
  });
  assert.throws(() => onboardingRestore(core, { id: imported.id }), { code: 'ROLLBACK_CONFLICT' });
  assert(!fs.existsSync(entry));
});

test('legacy saved manifests remain readable without rewriting or imposing new classification fields', (t) => {
  const { core, native } = fixture(t);
  put(native, 'skills/legacy/SKILL.md', 'Local procedure.');
  const operation = ready(core, native);
  const manifestPath = path.join(core.store.root, 'onboarding', operation.id, 'manifest.json');
  const legacy = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  delete legacy.classificationRequired;
  delete legacy.organization.classification;
  delete legacy.organization.absent;
  fs.writeFileSync(manifestPath, JSON.stringify(legacy));
  const before = fs.readFileSync(manifestPath);
  assert.equal(onboardingGet(core, { id: operation.id }).classificationRequired, undefined);
  assert(onboardingList(core).some((m) => m.id === operation.id));
  onboardingPlan(core, { id: operation.id });
  assert.deepEqual(fs.readFileSync(manifestPath), before);
  assert.equal(onboardingCutover(core, { id: operation.id }).phase, 'cutover');
  assert.equal(onboardingRestore(core, { id: operation.id }).phase, 'restored');
});

test('retained originals stay disabled and participate in the atomic revision guard', (t) => {
  const { core, native } = fixture(t);
  put(native, 'skills/mixed/SKILL.md', 'Delegate and review.');
  const imported = onboardingImport(core, { id: discover(core, native).id });
  verify(core, imported);
  const request = conversion(core, imported);
  request.operations = request.operations.filter((op) => op.op !== 'delete');
  const source = core.state().assets[0];
  const changeAssets = core.changeAssets.bind(core);
  const mock = t.mock.method(core, 'changeAssets', (input: unknown) => {
    changeAssets({
      summary: 'concurrent edit of retained original',
      operations: [
        {
          op: 'upsert',
          expectedRevision: source.revision,
          asset: { ...inputOf(source), description: 'Keep this edit' },
        },
      ],
    });
    return changeAssets(input);
  });
  assert.throws(() => onboardingOrganize(core, request));
  mock.mock.restore();
  assert.equal(core.state().assets.length, 1);
  assert.equal(core.state().assets[0].description, 'Keep this edit');
  assert(!core.state().assets[0].enabled);
  assert(!onboardingGet(core, { id: imported.id }).organization);
});

test('interrupted split cutover and committed organization rollback both resume after restart', (t) => {
  const { core, native, reopen } = fixture(t);
  const entry = put(native, 'skills/mixed/SKILL.md', 'Delegate and review.');
  put(native, 'skills/mixed/references/guide.md', 'Local checklist');
  const imported = onboardingImport(core, { id: discover(core, native).id });
  verify(core, imported);
  const request = conversion(core, imported);
  // A copy of the original can remain for reference, but stays disabled and tracked.
  request.operations = request.operations.filter((op) => op.op !== 'delete');
  const organized = onboardingOrganize(core, request);
  assert.equal(organized.organization!.assets.length, 5);
  assert.equal(core.state().assets.find((a) => a.id === imported.selected![0])!.enabled, false);
  const unlinkSync = fs.unlinkSync;
  const unlink = t.mock.method(fs, 'unlinkSync', (...args: Parameters<typeof fs.unlinkSync>) => {
    unlinkSync(...args);
    if (String(args[0]) === entry) throw new Error('crash after source removal');
  });
  assert.throws(() => onboardingCutover(core, { id: imported.id }), /crash after source removal/);
  unlink.mock.restore();
  assert.equal(onboardingGet(core, { id: imported.id }).phase, 'cutting-over');
  assert(!fs.existsSync(entry));
  assert.equal(onboardingCutover(core, { id: imported.id }).phase, 'cutover');
  const rollback = core.rollback.bind(core);
  const crash = t.mock.method(core, 'rollback', (input: unknown) => {
    rollback(input);
    throw new Error('crash after organization rollback');
  });
  assert.throws(
    () => onboardingRestore(core, { id: imported.id }),
    /crash after organization rollback/,
  );
  crash.mock.restore();
  assert.equal(core.state().assets.length, 1);
  assert(!fs.existsSync(entry));
  const changes = core.state().state.changesets.length;
  const restarted = reopen();
  assert.equal(onboardingRestore(restarted, { id: imported.id }).phase, 'restored');
  assert.equal(restarted.state().state.changesets.length, changes);
  assert.equal(fs.readFileSync(entry, 'utf8'), 'Delegate and review.');
  assert.equal(restarted.state().assets.length, 1);
  assert(!restarted.state().assets[0].enabled);
});
