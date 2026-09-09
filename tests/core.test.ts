import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.ts';
import { Core } from '../server/core.ts';
import { assetSchema, inputOf, type Asset } from '../server/domain.ts';
import { resolveContext, scopeMatches } from '../server/resolver.ts';
import { bootstrap, materialize } from '../server/adapters.ts';

function fixture(t: { after: (fn: () => void) => void }, seed = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aacl-test-'));
  const store = new Store(dir);
  const core = new Core(store);
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  if (seed) core.installStarter();
  return { core, store, dir };
}
const a = (id: string, extra: Record<string, unknown> = {}): Asset => ({
  ...assetSchema.parse({ id, type: 'rule', name: id, content: `${id} content`, ...extra }),
  revision: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
});
const upsert = (core: Core, asset: ReturnType<typeof assetSchema.parse>, expectedRevision = 0) =>
  core.changeAssets({
    summary: 'test edit',
    operations: [{ op: 'upsert', asset, expectedRevision }],
  });

test('native local model IDs and endpoints persist and reach runtime handoff', (t) => {
  const { core } = fixture(t, true);
  const config = core.overview().config;
  config.providers.push({ id: 'ollama', name: 'Ollama' });
  config.runtimes.push({
    id: 'ollama',
    name: 'Ollama',
    provider: 'ollama',
    endpoint: 'http://127.0.0.1:11434',
  });
  config.models.push({ id: 'org/llama3.2:latest', name: 'Local Llama', provider: 'ollama' });
  config.bindings.push({ role: 'orchestrator', model: 'org/llama3.2:latest', runtime: 'ollama' });
  core.updateConfig(config);
  const run = core.startRun({ command: '/issue-development test' });
  const handoff = core.handoff(run.id, { action: 'development' });
  assert.equal(handoff.model?.id, 'org/llama3.2:latest');
  assert.equal(handoff.runtime?.endpoint, 'http://127.0.0.1:11434');
});

test('scope uses AND across dimensions, OR within them, and directory boundaries', () => {
  assert.equal(
    scopeMatches(
      { workflow: ['issue', 'refactor'], role: ['implementer'], directory: ['src/foo'] },
      { workflow: 'issue', role: 'implementer', directory: 'src/foo/bar.ts' },
    ),
    true,
  );
  assert.equal(
    scopeMatches(
      { workflow: ['issue'], role: ['implementer'] },
      { workflow: 'issue', role: 'reviewer' },
    ),
    false,
  );
  assert.equal(scopeMatches({ directory: ['src/foo'] }, { directory: 'src/foobar/a.ts' }), false);
  assert.equal(
    scopeMatches({ directory: ['src/foo'] }, { directory: 'src/foo/../../private' }),
    false,
  );
  assert.equal(scopeMatches({ role: ['implementer'] }, {}), false);
});
test('same role receives task-specific assets without semantic inference', () => {
  const assets = [
    a('shared', { scope: { role: ['implementer'] } }),
    a('issue-rule', { scope: { workflow: ['issue'], role: ['implementer'] } }),
    a('refactor-rule', { scope: { workflow: ['refactor'], role: ['implementer'] } }),
    a('not-luna-specific', { content: 'This text mentions Luna and refactoring.' }),
  ];
  const issue = resolveContext(assets, { workflow: 'issue', role: 'implementer' });
  assert.deepEqual(issue.assets.map((a) => a.id).sort(), [
    'issue-rule',
    'not-luna-specific',
    'shared',
  ]);
  assert.deepEqual(
    resolveContext(assets, { workflow: 'refactor', role: 'implementer' })
      .assets.map((a) => a.id)
      .sort(),
    ['not-luna-specific', 'refactor-rule', 'shared'],
  );
  assert.equal(
    issue.content,
    resolveContext([...assets].reverse(), { workflow: 'issue', role: 'implementer' }).content,
  );
});
test('mandatory beats disable and override', () => {
  const result = resolveContext(
    [a('required', { mandatory: true, enabled: false }), a('replacement')],
    {},
    {
      project: {
        id: 'p',
        root: '.',
        name: 'p',
        disabled: ['required'],
        overrides: { required: 'replacement' },
        bindings: {},
      },
    },
  );
  assert.equal(result.entries.find((e) => e.asset.id === 'required')?.status, 'included');
  assert.equal(result.valid, true);
});
test('unresolved exclusive tie is a conflict, explicit priority can decide', () => {
  const assets = [a('a', { conflicts: ['b'] }), a('b')];
  assert.equal(resolveContext(assets, {}).valid, false);
  assert.equal(resolveContext(assets, {}).assets.length, 0);
  assert.deepEqual(
    resolveContext([assets[0], { ...assets[1], priority: 10 }], {}).assets.map((a) => a.id),
    ['b'],
  );
});
test('disabled dependencies, missing dependencies and cycles prevent parent success', () => {
  for (const assets of [
    [a('parent', { dependencies: ['child'] }), a('child', { enabled: false })],
    [a('parent', { dependencies: ['absent'] })],
    [a('parent', { dependencies: ['child'] }), a('child', { dependencies: ['parent'] })],
  ]) {
    const result = resolveContext(assets, {});
    assert.equal(result.valid, false);
    assert.equal(
      result.assets.some((a) => a.id === 'parent'),
      false,
    );
  }
});
test('dependencies are ordered before parents, on-demand skills remain unloaded until selected', () => {
  const assets = [
    a('parent', { priority: 99, dependencies: ['skill'] }),
    a('skill', { type: 'skill', activation: 'on-demand' }),
    a('unused-skill', { type: 'skill' }),
  ];
  assert.deepEqual(
    resolveContext(assets, {}).assets.map((a) => a.id),
    ['skill', 'parent'],
  );
});
test('compatibility is enforced and rejected asset never materializes', () => {
  const result = resolveContext([a('claude', { compatibility: 'claude-only' })], {
    runtime: 'codex',
  });
  assert.equal(result.valid, false);
  assert.equal(result.assets.length, 0);
});
test('default is empty, starter installation is explicit and idempotent', (t) => {
  const { core } = fixture(t);
  assert.equal(core.state().assets.length, 0);
  const installed = core.installStarter();
  assert.ok(installed.installed > 0);
  const count = core.state().assets.length;
  assert.equal(core.installStarter().installed, 0);
  assert.equal(core.state().assets.length, count);
});
test('plain requests and standalone skills stay advisory; cannot transition or get development handoff', (t) => {
  const { core } = fixture(t, true);
  for (const command of ['Implement the feature and create a PR', '/security-review src']) {
    const run = core.startRun({ command });
    assert.equal(run.mode, 'advisory');
    assert.equal(run.workflow, null);
    assert.throws(
      () => core.transition(run.id, { kind: 'advance', to: 'implementation', expectedVersion: 1 }),
      /Advisory/,
    );
    assert.throws(() => core.handoff(run.id, { action: 'development' }), /Development-capable/);
    const snapshot = core.getSnapshot(run.snapshotIds[0]);
    assert.equal(snapshot.workflowId, null);
    assert.equal(snapshot.workflowRevision, null);
  }
  assert.throws(() => core.startRun({ context: { workflow: 'issue-development' } }), /起動対象/);
});
test('workflow definitions validate graph, duplicate stages and role references', (t) => {
  const { core } = fixture(t, true);
  const workflow = core.state().assets.find((a) => a.id === 'issue-development')!;
  const invalid = inputOf(workflow);
  invalid.workflow!.stages[0].transitions.push({
    to: 'absent',
    kind: 'advance',
    requiredArtifacts: [],
  });
  assert.throws(() => upsert(core, invalid, 1), /不正な遷移/);
  const missing = inputOf(workflow);
  missing.workflow!.stages[0].role = 'unknown';
  missing.workflow!.entryRole = 'unknown';
  assert.throws(() => upsert(core, missing, 1), /参照先/);
  assert.equal(core.state().assets.find((a) => a.id === workflow.id)!.revision, 1);
});
test('explicit launch pins workflow revision; state cannot skip constraints; snapshots are immutable', (t) => {
  const { core } = fixture(t, true);
  const run = core.startRun({ command: '/issue-development #123' });
  const initial = core.getSnapshot(run.snapshotIds[0]);
  assert.equal(run.mode, 'workflow');
  assert.equal(run.stage, 'intake');
  assert.equal(initial.workflowRevision, 1);
  const workflow = core.state().assets.find((a) => a.id === 'issue-development')!;
  upsert(core, { ...inputOf(workflow), content: 'New workflow definition' }, 1);
  assert.throws(
    () => core.transition(run.id, { expectedVersion: 1, to: 'implementation', kind: 'advance' }),
    /根拠/,
  );
  assert.throws(
    () =>
      core.transition(run.id, {
        expectedVersion: 1,
        to: 'specification',
        kind: 'advance',
        criteria: { '受付・計画の結果を確認した': 'Confirmed' },
      }),
    /成果物/,
  );
  const moved = core.transition(run.id, {
    expectedVersion: 1,
    to: 'specification',
    kind: 'advance',
    criteria: { '受付・計画の結果を確認した': 'Confirmed' },
    artifacts: { brief: 'brief.md' },
  });
  assert.equal(moved.stage, 'specification');
  assert.equal(moved.workflow?.revision, 1);
  assert.equal(
    core.getSnapshot(moved.snapshotIds.at(-1)!).resolution.assets.find((a) => a.id === workflow.id)!
      .revision,
    1,
  );
  assert.deepEqual(core.getSnapshot(initial.id), initial);
  assert.throws(
    () =>
      core.transition(run.id, {
        kind: 'retry',
        to: 'specification',
        note: 'retry',
        expectedVersion: 1,
      }),
    /更新されています/,
  );
});
test('complete real workflow through every stage with artifacts and evidence', (t) => {
  const { core } = fixture(t, true);
  let run = core.startRun({ workflowId: 'issue-development', instruction: '#456' });
  for (const stage of run.workflow!.workflow!.stages) {
    const criteria = Object.fromEntries(
      [...stage.completionCriteria, ...run.workflow!.workflow!.completionCriteria].map((c) => [
        c,
        'validated',
      ]),
    );
    const edge = stage.transitions.find((t) => t.kind === 'advance');
    run = core.transition(run.id, {
      expectedVersion: run.version,
      kind: edge ? 'advance' : 'complete',
      to: edge?.to,
      criteria,
      artifacts: Object.fromEntries((edge?.requiredArtifacts ?? []).map((a) => [a, `${a}.md`])),
    });
  }
  assert.equal(run.status, 'completed');
  assert.equal(run.snapshotIds.length, 6);
  assert.throws(() => core.handoff(run.id, {}), /終了済み/);
});
test('user-defined binding resolves model and runtime; provider mismatch is rejected', (t) => {
  const { core } = fixture(t, true);
  const config = core.state().state.config;
  config.models = [{ id: 'chosen', name: 'Chosen model', provider: 'openai' }];
  config.bindings = [{ role: 'orchestrator', model: 'chosen', runtime: 'codex' }];
  core.updateConfig(config);
  const run = core.startRun({ workflowId: 'issue-development' });
  assert.equal(run.context.model, 'chosen');
  assert.equal(run.context.runtime, 'codex');
  assert.equal(run.context.provider, 'openai');
  assert.throws(
    () => core.handoff(run.id, { context: { model: 'chosen', runtime: 'claude' } }),
    /Provider/,
  );
  assert.throws(() => core.handoff(run.id, { context: { role: 'implementer' } }), /変更できません/);
});
test('journal proposal never mutates assets until human approval; stale proposal fails atomically', (t) => {
  const { core } = fixture(t, true);
  const run = core.startRun({ command: '/issue-development #123' });
  const journal = core.addJournal({
    snapshotId: run.snapshotIds[0],
    kind: 'friction',
    observation: 'Planning instructions were unclear',
  });
  const review = core.requestReview({
    journalIds: [journal.id],
    reason: 'Review planning guidance',
  });
  const asset = core.state().assets.find((a) => a.id === 'review-evidence')!;
  core.submitReview(review.id, {
    proposedBy: 'test-runtime',
    reason: 'The problem applies to all review roles, not a particular model.',
    operations: [
      {
        op: 'upsert',
        asset: { ...inputOf(asset), content: 'Revised guidance', scope: { role: ['reviewer'] } },
        expectedRevision: 1,
      },
    ],
  });
  assert.equal(core.state().assets.find((a) => a.id === asset.id)!.content, asset.content);
  const decision = core.decideReview(review.id, true);
  assert.equal(decision.changeSet?.origin, 'journal-review');
  assert.equal(decision.changeSet?.sourceJournals[0], journal.id);
  assert.equal(core.state().assets.find((a) => a.id === asset.id)!.revision, 2);
  const review2 = core.requestReview({ journalIds: [journal.id], reason: 'Follow-up' });
  const current = core.state().assets.find((a) => a.id === asset.id)!;
  core.submitReview(review2.id, {
    proposedBy: 'test',
    reason: 'Follow-up',
    operations: [
      { op: 'upsert', asset: { ...inputOf(current), content: 'Proposal' }, expectedRevision: 2 },
    ],
  });
  upsert(core, { ...inputOf(current), content: 'Independent user edit' }, 2);
  assert.throws(() => core.decideReview(review2.id, true), /変更されています/);
  assert.equal(core.state().state.reviews.find((r) => r.id === review2.id)!.status, 'pending');
});
test('asset edits use optimistic concurrency and multi-asset failure is atomic', (t) => {
  const { core } = fixture(t);
  upsert(core, inputOf(a('one')));
  assert.throws(
    () =>
      core.changeAssets({
        summary: 'atomic test',
        operations: [
          { op: 'upsert', asset: inputOf(a('two')), expectedRevision: 0 },
          { op: 'upsert', asset: inputOf(a('one')), expectedRevision: 0 },
        ],
      }),
    /変更されています/,
  );
  assert.equal(
    core.state().assets.some((a) => a.id === 'two'),
    false,
  );
});
test('history links to real git commits; rollback appends a new revision and protects later edits', (t) => {
  const { core } = fixture(t);
  const created = upsert(core, inputOf(a('one')));
  assert.match(created.gitCommit!, /^[a-f0-9]{40}$/);
  const edited = upsert(core, inputOf(a('one', { content: 'edited' })), 1);
  const restored = core.rollback({ changeSetId: edited.id });
  assert.equal(restored.changes[0].after?.revision, 3);
  assert.equal(restored.changes[0].after?.content, 'one content');
  assert.throws(() => core.rollback({ changeSetId: created.id }), /後続の変更/);
  core.rollback({ assetId: 'one', revision: 2, expectedRevision: 3 });
  assert.equal(core.state().assets[0].revision, 4);
  assert.equal(core.state().assets[0].content, 'edited');
});
test('project canonical assets live in .aacl and overlay is isolated', (t) => {
  const { core, dir } = fixture(t);
  const projectRoot = path.join(dir, 'workspace');
  fs.mkdirSync(projectRoot);
  const p = core.initProject({ root: projectRoot, name: 'Project' });
  assert.equal(core.initProject({ root: projectRoot, name: 'Project' }).id, p.id);
  upsert(core, inputOf(a('global')));
  upsert(core, inputOf(a('local', { projectId: p.id })));
  const projectFile = path.join(projectRoot, '.aacl/assets.json');
  const projectAssets = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  assert.equal(projectAssets[0].id, 'local');
  assert.deepEqual(
    core.preview({ context: {} }).assets.map((a) => a.id),
    ['global'],
  );
  core.updateOverlay(p.id, { disabled: ['global'], overrides: {}, bindings: {} });
  assert.deepEqual(
    core.preview({ context: { project: p.id } }).assets.map((a) => a.id),
    ['local'],
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(projectRoot, '.aacl/project.json'), 'utf8')).id,
    p.id,
  );
});
test('filesystem transaction recovers after interruption and single-writer lock refuses a second Core', (t) => {
  const { store, core, dir } = fixture(t);
  assert.throws(() => new Store(dir), /既に起動/);
  upsert(core, inputOf(a('one')));
  const assetFile = path.join(dir, 'assets.json');
  const assets = JSON.parse(fs.readFileSync(assetFile, 'utf8'));
  assets[0].content = 'Recovered durable transaction';
  fs.writeFileSync(
    path.join(dir, 'transaction.json'),
    JSON.stringify({ files: [{ path: assetFile, value: assets }] }),
  );
  assert.equal(store.load().assets[0].content, 'Recovered durable transaction');
  assert.equal(fs.existsSync(path.join(dir, 'transaction.json')), false);
});
test('persisted state survives reopening; corruption and future versions are not overwritten', (t) => {
  const { store, core, dir } = fixture(t);
  upsert(core, inputOf(a('one')));
  const run = core.startRun({ instruction: 'Question' });
  store.close();
  const reopened = new Store(dir);
  assert.equal(reopened.load().state.runs[0].id, run.id);
  reopened.close();
  const statePath = path.join(dir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.schemaVersion = 99;
  const text = JSON.stringify(state);
  fs.writeFileSync(statePath, text);
  assert.throws(() => new Store(dir), /未対応/);
  assert.equal(fs.readFileSync(statePath, 'utf8'), text);
});
test('bootstrap and runtime materialization are idempotent, portable and read-only', (t) => {
  const { core } = fixture(t, true);
  assert.equal(bootstrap(), bootstrap());
  const before = core.state();
  for (const runtime of ['claude', 'codex']) {
    const bundle = materialize(core, { runtime, context: { workflow: 'issue-development' } });
    const skill = bundle.files.find((f) => f.path.endsWith('/issue-development/SKILL.md'))!;
    assert.ok(skill);
    assert.match(skill.content, /aacl_session_start/);
    assert.equal(skill.path.startsWith(runtime === 'codex' ? '.agents/' : '.claude/'), true);
    assert.deepEqual(
      bundle,
      materialize(core, { runtime, context: { workflow: 'issue-development' } }),
    );
  }
  assert.deepEqual(core.state(), before);
});
test('native import keeps content and separates explicit scope; path-like IDs are rejected', (t) => {
  const { core } = fixture(t);
  core.importNative({
    id: 'imported',
    name: 'fallback',
    type: 'skill',
    content: '---\nname: Imported\ndescription: Native skill\n---\n\nReview implementer and Luna.',
  });
  const asset = core.state().assets[0];
  assert.equal(asset.name, 'Imported');
  assert.deepEqual(asset.scope, {});
  assert.equal(asset.activation, 'on-demand');
  assert.throws(() =>
    core.importNative({ id: '../outside', name: 'x', type: 'rule', content: 'x' }),
  );
});
test('quality and cost aggregate by workflow revision, stage and role', (t) => {
  const { core } = fixture(t, true);
  let run = core.startRun({ workflowId: 'issue-development' });
  core.addJournal({
    snapshotId: run.snapshotIds[0],
    kind: 'defect',
    observation: 'A specific defect',
  });
  run = core.transition(run.id, {
    kind: 'retry',
    to: 'intake',
    note: 'Repeat with corrected input',
    expectedVersion: 1,
  });
  const metrics = core.metrics()[0];
  assert.equal(metrics.defects, 1);
  assert.equal(metrics.retries, 1);
  assert.equal(metrics.snapshots, 2);
  assert.ok(metrics.averageTokens > 0);
});
test('an explicit runtime selection persists across stage transitions', (t) => {
  const { core } = fixture(t, true);
  const run = core.startRun({ workflowId: 'issue-development', context: { runtime: 'codex' } });
  const next = core.transition(run.id, {
    kind: 'advance',
    to: 'specification',
    expectedVersion: 1,
    artifacts: { brief: 'brief.md' },
    criteria: { '受付・計画の結果を確認した': 'confirmed' },
  });
  assert.equal(next.context.runtime, 'codex');
  assert.equal(next.context.provider, 'openai');
});
test('capability registry does not auto-activate; required capability needs both connection and permission', () => {
  const cap = a('git-tools', {
    type: 'capability',
    capability: { provider: 'github-mcp', tools: ['read_issue'], connected: true, allowed: false },
  });
  assert.equal(resolveContext([cap], {}).valid, true);
  assert.equal(
    resolveContext([cap, a('consumer', { dependencies: ['git-tools'] })], {}).valid,
    false,
  );
  const allowed = { ...cap, capability: { ...cap.capability!, allowed: true } };
  assert.equal(
    resolveContext([allowed, a('consumer', { dependencies: ['git-tools'] })], {}).valid,
    true,
  );
});
test('project binding activates a rule in its explicitly rebound scope', () => {
  const project = {
    id: 'project',
    root: '.',
    name: 'Project',
    disabled: [],
    overrides: {},
    bindings: { rule: { role: ['reviewer'] } },
  };
  const assets = [a('rule', { scope: { role: ['implementer'] } })];
  assert.deepEqual(
    resolveContext(assets, { role: 'reviewer' }, { project }).assets.map((a) => a.id),
    ['rule'],
  );
  assert.equal(resolveContext(assets, { role: 'implementer' }, { project }).assets.length, 0);
});
test('higher-priority winner resolves lower-priority ties without false conflicts', () => {
  const result = resolveContext(
    [a('winner', { priority: 20, conflicts: ['a', 'b'] }), a('a', { conflicts: ['b'] }), a('b')],
    {},
  );
  assert.equal(result.valid, true);
  assert.deepEqual(
    result.assets.map((a) => a.id),
    ['winner'],
  );
});
