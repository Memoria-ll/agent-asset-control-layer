import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../server/store.ts';
import { Core } from '../server/core.ts';
import { createApp, errorHandler } from '../server/app.ts';

const execute = promisify(execFile);
const bin = fileURLToPath(new URL('../bin/aacl.mjs', import.meta.url));
function cli(args: string[], cwd: string, base: string) {
  return execute(process.execPath, [bin, ...args], {
    cwd,
    env: { ...process.env, AACL_API_URL: base },
    timeout: 15_000,
  });
}

async function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aacl-cli-'));
  const store = new Store(path.join(dir, 'core'));
  const core = new Core(store);
  const app = createApp(core);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, base, core };
}

test('aacl init registers cwd or an explicit path through Core and reuses the Project ID', async (t) => {
  const { dir, base, core } = await fixture(t);
  const projectRoot = path.join(dir, '対象 project');
  fs.mkdirSync(projectRoot);
  fs.writeFileSync(path.join(projectRoot, 'tsconfig.json'), '{"extends":"./missing.json"}');

  const first = await cli(['init'], projectRoot, base);
  assert.equal(first.stderr, '');
  const project = JSON.parse(first.stdout);
  assert.equal(project.root, fs.realpathSync(projectRoot));
  assert.equal(project.name, '対象 project');
  const marker = path.join(projectRoot, '.aacl', 'project.json');
  assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).id, project.id);
  assert.equal(core.state().state.projects[0].id, project.id);
  assert.equal(JSON.parse((await cli(['init'], projectRoot, base)).stdout).id, project.id);
  assert.equal(JSON.parse((await cli(['init', projectRoot], dir, base)).stdout).id, project.id);

  const otherRoot = path.join(dir, 'other project');
  fs.mkdirSync(otherRoot);
  const other = JSON.parse(
    (await cli(['init', '../other project', '別のProject'], projectRoot, base)).stdout,
  );
  assert.equal(other.root, fs.realpathSync(otherRoot));
  assert.equal(other.name, '別のProject');
  assert.notEqual(other.id, project.id);
  assert.equal(core.state().state.projects.length, 2);
  assert.equal(fs.existsSync(path.join(dir, '.aacl')), false);
});

test('aacl init adopts identity from the Project when Core has no registration yet', async (t) => {
  const { dir, base, core } = await fixture(t);
  const projectRoot = path.join(dir, 'existing-project');
  fs.mkdirSync(path.join(projectRoot, '.aacl'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.aacl', 'project.json'), '{"id":"project-existing"}');
  fs.writeFileSync(path.join(projectRoot, '.aacl', 'assets.json'), '[]');
  assert.equal(core.state().state.projects.length, 0);
  const project = JSON.parse((await cli(['init'], projectRoot, base)).stdout);
  assert.equal(project.id, 'project-existing');
  assert.equal(core.state().state.projects[0].id, 'project-existing');
});

test('aacl help needs no Core, and unavailable Core fails on stderr without creating a Project', async (t) => {
  const { dir, base } = await fixture(t);
  const unavailable = 'http://127.0.0.1:0';
  const help = await cli(['--help'], dir, unavailable);
  assert.match(help.stdout, /init \[path\]/);
  assert.equal(help.stderr, '');
  await assert.rejects(cli(['init'], dir, unavailable), (error: any) => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '');
    assert.match(error.stderr, /AACL Coreへ接続できません/);
    assert.ok(error.stderr.includes(unavailable));
    return true;
  });
  await assert.rejects(cli(['init', '.', 'name', 'unexpected'], dir, base), (error: any) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /使い方: aacl init/);
    return true;
  });
  assert.equal(fs.existsSync(path.join(dir, '.aacl')), false);
});
