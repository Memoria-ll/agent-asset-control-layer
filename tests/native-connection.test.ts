import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { Core } from '../server/core.ts';
import { Store } from '../server/store.ts';
import {
  onboardingConnect,
  onboardingDiscover,
  onboardingGet,
  onboardingRestore,
  onboardingImport,
} from '../server/onboarding.ts';
import { nativeConnectionTarget } from '../server/native-connection.ts';

function fixture(t: TestContext, runtime: 'codex' | 'claude' | 'cursor' = 'codex') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aacl-connection-test-'));
  const store = new Store(path.join(dir, 'store'));
  const core = new Core(store);
  const home = path.join(dir, 'home');
  const native = path.join(home, `.${runtime}`);
  fs.mkdirSync(native, { recursive: true });
  const config =
    runtime === 'claude'
      ? path.join(home, '.claude.json')
      : path.join(native, runtime === 'codex' ? 'config.toml' : 'mcp.json');
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const discover = () => onboardingDiscover(core, { roots: [{ path: native, runtime }] });
  return { dir, core, native, config, discover };
}
const endpoint = 'http://127.0.0.1:4780/mcp';
const request = (id: string) => ({ id, endpoint, userRequest: 'Install this AACL MCP connection' });

function crashConnection(dir: string, id: string, native: string, fault: 'link' | 'backup') {
  const adapter = new URL('../server/native-connection.ts', import.meta.url).href;
  const adapters = new URL('../server/adapters.ts', import.meta.url).href;
  const script = `
    import fs from 'node:fs';
    import { installNativeConnections, nativeConnectionTarget } from ${JSON.stringify(adapter)};
    import { bootstrap } from ${JSON.stringify(adapters)};
    const [directory, native, endpoint, userRequest, fault] = process.argv.slice(1);
    const target = nativeConnectionTarget({path:native,runtime:'codex'});
    const open = fs.openSync, close = fs.closeSync, write = fs.writeFileSync, link = fs.linkSync;
    const descriptors = new Map();
    fs.openSync = (...args) => { const fd=open(...args); descriptors.set(fd,String(args[0])); return fd; };
    fs.closeSync = (fd) => { descriptors.delete(fd); return close(fd); };
    fs.writeFileSync = (file,data,...args) => {
      if (fault === 'backup' && typeof file === 'number' && /\\.before\\.[^.]+\\.tmp$/.test(descriptors.get(file) ?? '')) {
        write(file,String(data).slice(0,4),...args); fs.fsyncSync(file); process.exit(89);
      }
      return write(file,data,...args);
    };
    fs.linkSync = (...args) => { link(...args); if (fault === 'link' && String(args[1]) === target.configPath) process.exit(88); };
    installNativeConnections(directory,[target],endpoint,userRequest,bootstrap(endpoint));
    process.exit(90);
  `;
  const directory = path.join(dir, 'store', 'onboarding', id, 'connections');
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      script,
      directory,
      native,
      endpoint,
      request(id).userRequest,
      fault,
    ],
    {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      timeout: 20_000,
    },
  );
  assert.equal(child.status, fault === 'link' ? 88 : 89, child.stderr);
  return directory;
}

for (const runtime of ['codex', 'claude', 'cursor'] as const) {
  test(`${runtime} installs an actual native MCP entry, protects secret backups, and restores exact bytes/mode`, (t) => {
    const { core, native, config, discover } = fixture(t, runtime);
    const original =
      runtime === 'codex'
        ? 'model = "model-name" # retained comment\n[projects."/tmp/project"]\ntrust_level = "trusted"\n[mcp_servers.existing]\nurl = "https://example.test/mcp"\nbearer_token_env_var = "AUTH_SENTINEL"\n'
        : '{\n  "auth": { "token": "AUTH_SENTINEL" },\n  "large": 123456789012345678901234567890,\n  "mcpServers": { "existing": { "url": "https://example.test/mcp", "headers": { "Authorization": "OTHER_SECRET" } } }\n}\n';
    fs.writeFileSync(config, original);
    fs.chmodSync(config, 0o640);
    const operation = discover();
    const connected = onboardingConnect(core, request(operation.id));
    assert.equal(connected.connection?.phase, 'installed');
    assert.equal(connected.verification, undefined);
    const updated = fs.readFileSync(config, 'utf8');
    if (runtime === 'codex') {
      assert(updated.startsWith(original));
      assert(updated.includes(`[mcp_servers.aacl]\nurl = "${endpoint}"`));
    } else {
      assert(updated.includes('"large": 123456789012345678901234567890'));
      const parsed = JSON.parse(updated);
      assert.equal(parsed.auth.token, 'AUTH_SENTINEL');
      assert.equal(parsed.mcpServers.existing.headers.Authorization, 'OTHER_SECRET');
      assert.equal(parsed.mcpServers.aacl.url, endpoint);
      if (runtime === 'claude') assert.equal(parsed.mcpServers.aacl.type, 'http');
    }
    assert.equal(fs.statSync(config).mode & 0o777, 0o600);
    const guide = connected.connection!.targets[0].bootstrapPath;
    assert.equal(guide, path.join(native, 'AACL-BOOTSTRAP.md'));
    assert(fs.readFileSync(guide, 'utf8').includes('aacl_session_start'));
    assert(!JSON.stringify(connected).includes('AUTH_SENTINEL'));
    assert(!JSON.stringify(onboardingGet(core, { id: operation.id })).includes('OTHER_SECRET'));
    const privateConfig = connected.connection!.files.find((f) => f.kind === 'config')!;
    assert.equal(fs.readFileSync(privateConfig.backupPath!, 'utf8'), original);
    assert.equal(fs.statSync(privateConfig.backupPath!).mode & 0o777, 0o600);
    assert.equal(fs.statSync(privateConfig.stagedPath).mode & 0o777, 0o600);
    const manifest = fs.readFileSync(
      path.join(core.store.root, 'onboarding', operation.id, 'connections/manifest.json'),
      'utf8',
    );
    assert(!manifest.includes('AUTH_SENTINEL'));
    const again = onboardingConnect(core, request(operation.id));
    assert.equal(again.connection!.files.length, connected.connection!.files.length);
    assert.equal(fs.readFileSync(config, 'utf8'), updated);
    const restored = onboardingRestore(core, { id: operation.id });
    assert.equal(restored.connection?.phase, 'restored');
    assert.equal(fs.readFileSync(config, 'utf8'), original);
    assert.equal(fs.statSync(config).mode & 0o777, 0o640);
    assert(!fs.existsSync(guide));
    assert.equal(core.state().assets.length, 0);
  });
}

test('absent native config is created exclusively and removed on restore; generated guide is never imported', (t) => {
  const { core, native, config, discover } = fixture(t);
  const operation = discover();
  const connected = onboardingConnect(core, request(operation.id));
  assert(fs.existsSync(config));
  assert.equal(connected.connection!.files.find((f) => f.kind === 'config')!.beforeHash, null);
  const second = onboardingDiscover(core, {
    id: 'rediscover-connected',
    roots: [{ path: native, runtime: 'codex' }],
  });
  assert.equal(second.candidates.length, 0);
  assert(second.issues.some((i) => i.code === 'GENERATED_BOOTSTRAP'));
  assert.throws(() => onboardingImport(core, { id: second.id }), /supported discovered/);
  onboardingRestore(core, { id: operation.id });
  assert(!fs.existsSync(config));
  assert.equal(onboardingRestore(core, { id: operation.id }).phase, 'restored');
});

test('connection install targets project scope when a project is registered', (t) => {
  const { core, dir } = fixture(t, 'claude');
  const projectRoot = path.join(dir, 'project');
  const native = path.join(projectRoot, '.claude');
  fs.mkdirSync(native, { recursive: true });
  const project = core.initProject({ root: projectRoot, name: 'project' });
  const operation = onboardingDiscover(core, {
    roots: [{ path: native, runtime: 'claude', projectId: project.id }],
  });
  const result = onboardingConnect(core, request(operation.id));
  assert.equal(result.connection!.targets[0].configPath, path.join(projectRoot, '.mcp.json'));
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(projectRoot, '.mcp.json'), 'utf8')).mcpServers.aacl.url,
    endpoint,
  );
  assert.equal(
    nativeConnectionTarget({ path: native, runtime: 'codex' }, projectRoot).configPath,
    path.join(projectRoot, '.codex/config.toml'),
  );
  assert.equal(
    nativeConnectionTarget({ path: native, runtime: 'cursor' }, projectRoot).configPath,
    path.join(projectRoot, '.cursor/mcp.json'),
  );
  assert.throws(
    () => nativeConnectionTarget({ path: projectRoot, runtime: 'codex' }),
    /known runtime directory/,
  );
});

test('conflicting native AACL definitions and ambiguous syntax cause no native writes or secret-bearing errors', (t) => {
  const { core, config, native, discover } = fixture(t);
  const operation = discover();
  for (const content of [
    '[mcp_servers.aacl]\nurl = "https://AUTH_SENTINEL.invalid/mcp"\n',
    '[mcp_servers."aacl"]\ncommand = "AUTH_SENTINEL"\n',
    '["mcp_servers".aacl]\nurl = "http://127.0.0.1:4780/mcp"\nenabled = false\n',
    'mcp_servers = { aacl = { url = "AUTH_SENTINEL" } }\n',
    'model = """AUTH_SENTINEL\nmultiline"""\n',
    'broken = ["AUTH_SENTINEL"\n',
    '[same]\nx = 1\n[same]\ny = 2\n',
  ]) {
    fs.writeFileSync(config, content);
    assert.throws(
      () => onboardingConnect(core, request(operation.id)),
      (error: Error) => !error.message.includes('AUTH_SENTINEL'),
    );
    assert.equal(fs.readFileSync(config, 'utf8'), content);
    assert(!fs.existsSync(path.join(native, 'AACL-BOOTSTRAP.md')));
  }
});

test('JSON duplicate keys, malformed types, and existing incompatible servers fail without rewriting unrelated bytes', (t) => {
  const { core, config, discover } = fixture(t, 'claude');
  const operation = discover();
  for (const content of [
    '{ "AUTH_SENTINEL": ',
    '{"x":1,"x":2}',
    '{"mcpServers":[]}',
    '{"mcpServers":{"aacl":{"url":"http://127.0.0.1:4780/mcp"}}}',
    '{"mcpServers":{"aacl":{"type":"http","url":"http://different.invalid"}}}',
    '{"mcpServers":{"aacl":{"type":"http","url":"http://127.0.0.1:4780/mcp","disabled":true}}}',
  ]) {
    fs.writeFileSync(config, content);
    assert.throws(
      () => onboardingConnect(core, request(operation.id)),
      (error: Error) => !error.message.includes('AUTH_SENTINEL'),
    );
    assert.equal(fs.readFileSync(config, 'utf8'), content);
  }
});

test('an existing matching AACL definition is left intact, including auth headers and later edits', (t) => {
  const { core, config, discover } = fixture(t, 'cursor');
  const original = JSON.stringify({
    mcpServers: { aacl: { url: endpoint, headers: { Authorization: 'AUTH_SENTINEL' } } },
  });
  fs.writeFileSync(config, original);
  const operation = discover();
  const connected = onboardingConnect(core, request(operation.id));
  assert.equal(connected.connection!.files.find((f) => f.kind === 'config')!.changed, false);
  assert.equal(fs.readFileSync(config, 'utf8'), original);
  fs.writeFileSync(config, original + '\n');
  onboardingRestore(core, { id: operation.id });
  assert.equal(fs.readFileSync(config, 'utf8'), original + '\n');
});

test('interruption immediately after atomic native install and restore is resumable', (t) => {
  const { core, config, discover } = fixture(t);
  const original = 'model = "original"\n';
  fs.writeFileSync(config, original);
  const operation = discover();
  const rename = fs.renameSync;
  let fail = true;
  const mock = t.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
    rename(...args);
    if (String(args[1]) === config && fail) {
      fail = false;
      throw new Error('simulated process interruption');
    }
  });
  assert.throws(() => onboardingConnect(core, request(operation.id)), /interruption/);
  assert(fs.readFileSync(config, 'utf8').includes('[mcp_servers.aacl]'));
  assert.equal(onboardingGet(core, { id: operation.id }).connection?.phase, 'installing');
  assert.equal(onboardingConnect(core, request(operation.id)).connection?.phase, 'installed');
  fail = true;
  assert.throws(() => onboardingRestore(core, { id: operation.id }), /interruption/);
  assert.equal(fs.readFileSync(config, 'utf8'), original);
  assert.equal(onboardingRestore(core, { id: operation.id }).connection?.phase, 'restored');
  mock.mock.restore();
});

test('compare hashes prevent overwriting later native edits and unsafe backup substitutions', (t) => {
  const { core, config, discover, dir } = fixture(t);
  fs.writeFileSync(config, 'model = "original"\n');
  const operation = discover();
  const result = onboardingConnect(core, request(operation.id));
  const installed = fs.readFileSync(config, 'utf8');
  fs.writeFileSync(config, installed + '\n# newer edit\n');
  assert.throws(() => onboardingRestore(core, { id: operation.id }), /changed after installation/);
  assert(fs.readFileSync(config, 'utf8').endsWith('# newer edit\n'));
  fs.writeFileSync(config, installed);
  const backup = result.connection!.files.find((f) => f.kind === 'config')!.backupPath!;
  const outside = path.join(dir, 'outside');
  fs.writeFileSync(outside, 'outside');
  fs.unlinkSync(backup);
  fs.symlinkSync(outside, backup);
  assert.throws(() => onboardingRestore(core, { id: operation.id }), /symbolic links/);
  assert.equal(fs.readFileSync(config, 'utf8'), installed);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
});

test('symlinks, oversized configs, request changes, and bootstrap collisions fail closed', (t) => {
  const { core, native, config, discover, dir } = fixture(t);
  const outside = path.join(dir, 'outside.toml');
  fs.writeFileSync(outside, 'model = "original"\n');
  const operation = discover();
  fs.symlinkSync(outside, config);
  assert.throws(() => onboardingConnect(core, request(operation.id)), /symbolic links/);
  fs.unlinkSync(config);
  fs.writeFileSync(config, '#'.repeat(2_000_001));
  assert.throws(() => onboardingConnect(core, request(operation.id)), /bounded regular/);
  fs.writeFileSync(config, 'model = "original"\n');
  fs.writeFileSync(path.join(native, 'AACL-BOOTSTRAP.md'), 'user guide');
  assert.throws(() => onboardingConnect(core, request(operation.id)), /different bootstrap guide/);
  assert.equal(fs.readFileSync(config, 'utf8'), 'model = "original"\n');
  fs.unlinkSync(path.join(native, 'AACL-BOOTSTRAP.md'));
  onboardingConnect(core, request(operation.id));
  assert.throws(
    () =>
      onboardingConnect(core, { ...request(operation.id), endpoint: 'http://localhost:4781/mcp' }),
    /original connection request/,
  );
  assert.throws(() => onboardingConnect(core, { id: operation.id, userRequest: '' }));
  assert.equal(fs.readFileSync(outside, 'utf8'), 'model = "original"\n');
});

for (const resume of ['connect', 'restore'] as const) {
  test(`process exit after exclusive link recovers its recorded twin during ${resume}`, (t) => {
    const { core, config, native, dir, discover } = fixture(t);
    const operation = discover();
    crashConnection(dir, operation.id, native, 'link');
    assert.equal(fs.statSync(config).nlink, 2);
    const file = onboardingGet(core, { id: operation.id }).connection!.files.find(
      (f) => f.path === config,
    )!;
    assert(file.creation);
    assert.equal(fs.statSync(file.creation.tempPath).ino, fs.statSync(config).ino);
    if (resume === 'connect') {
      assert.equal(onboardingConnect(core, request(operation.id)).connection!.phase, 'installed');
      assert.equal(fs.statSync(config).nlink, 1);
    }
    assert.equal(onboardingRestore(core, { id: operation.id }).connection!.phase, 'restored');
    assert(!fs.existsSync(config));
    assert(!fs.existsSync(file.creation.tempPath));
  });

  test(`process exit during backup leaves native config intact and permits ${resume}`, (t) => {
    const { core, config, native, dir, discover } = fixture(t);
    const original = 'model = "original"\n';
    fs.writeFileSync(config, original);
    const operation = discover();
    const directory = crashConnection(dir, operation.id, native, 'backup');
    const prepared = onboardingGet(core, { id: operation.id }).connection!;
    assert.equal(prepared.phase, 'prepared');
    const file = prepared.files.find((f) => f.path === config)!;
    assert(!fs.existsSync(file.backupPath!));
    assert(fs.readdirSync(directory).some((name) => /\.before\.[^.]+\.tmp$/.test(name)));
    assert.equal(fs.readFileSync(config, 'utf8'), original);
    if (resume === 'connect') {
      assert.equal(onboardingConnect(core, request(operation.id)).connection!.phase, 'installed');
      assert.equal(fs.readFileSync(file.backupPath!, 'utf8'), original);
    }
    assert.equal(onboardingRestore(core, { id: operation.id }).connection!.phase, 'restored');
    assert.equal(fs.readFileSync(config, 'utf8'), original);
  });
}

test('partial backup ENOSPC never publishes partial bytes and retry keeps the exact original', (t) => {
  const { core, config, discover } = fixture(t);
  const original = 'model = "original"\n';
  fs.writeFileSync(config, original);
  const operation = discover();
  const open = fs.openSync,
    write = fs.writeFileSync;
  const files = new Map<number, string>();
  const openMock = t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    const fd = open(...args);
    files.set(fd, String(args[0]));
    return fd;
  });
  const writeMock = t.mock.method(
    fs,
    'writeFileSync',
    (...args: Parameters<typeof fs.writeFileSync>) => {
      if (typeof args[0] === 'number' && /\.before\.[^.]+\.tmp$/.test(files.get(args[0]) ?? '')) {
        write(args[0], String(args[1]).slice(0, 4));
        throw Object.assign(new Error('simulated ENOSPC'), { code: 'ENOSPC' });
      }
      return write(...args);
    },
  );
  assert.throws(() => onboardingConnect(core, request(operation.id)), /ENOSPC/);
  writeMock.mock.restore();
  openMock.mock.restore();
  const status = onboardingGet(core, { id: operation.id }).connection!;
  assert.equal(status.phase, 'prepared');
  assert(!fs.existsSync(status.files.find((f) => f.path === config)!.backupPath!));
  assert.equal(fs.readFileSync(config, 'utf8'), original);
  assert.equal(onboardingConnect(core, request(operation.id)).connection!.phase, 'installed');
  onboardingRestore(core, { id: operation.id });
  assert.equal(fs.readFileSync(config, 'utf8'), original);
});

test('creation recovery refuses unrecorded hardlinks, third links and changed staging bytes', (t) => {
  const { core, config, native, dir, discover } = fixture(t);
  const operation = discover();
  crashConnection(dir, operation.id, native, 'link');
  const creation = onboardingGet(core, { id: operation.id }).connection!.files.find(
    (f) => f.path === config,
  )!.creation!;
  const extra = path.join(dir, 'unrelated-hardlink');
  fs.linkSync(config, extra);
  assert.throws(
    () => onboardingConnect(core, request(operation.id)),
    /staging file or its native target changed/,
  );
  assert.throws(
    () => onboardingRestore(core, { id: operation.id }),
    /staging file or its native target changed/,
  );
  assert.equal(fs.statSync(config).nlink, 3);
  fs.unlinkSync(extra);
  const original = fs.readFileSync(config, 'utf8');
  fs.writeFileSync(creation.tempPath, 'changed config');
  assert.throws(() => onboardingConnect(core, request(operation.id)), /staging file changed/);
  assert.equal(fs.readFileSync(config, 'utf8'), 'changed config');
  fs.writeFileSync(creation.tempPath, original);
  onboardingConnect(core, request(operation.id));
  const fake = path.join(native, '.aacl-connect-00000000-0000-0000-0000-000000000000.tmp');
  fs.linkSync(config, fake);
  assert.throws(() => onboardingConnect(core, request(operation.id)), /without hard links/);
  assert.throws(() => onboardingRestore(core, { id: operation.id }), /without hard links/);
  assert.equal(fs.statSync(fake).nlink, 2);
});
