import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Core } from '../server/core.ts';
import { Store } from '../server/store.ts';
import { assetSchema, inputOf, type Run } from '../server/domain.ts';
import { normalizeDirectory } from '../server/paths.ts';

function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aacl-improvements-'));
  const store = new Store(path.join(root, 'data')),
    core = new Core(store);
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const save = (value: Record<string, unknown>, expectedRevision = 0) =>
    core.changeAssets({
      summary: 'test change',
      operations: [{ op: 'upsert', asset: assetSchema.parse(value), expectedRevision }],
    });
  return { root, store, core, save };
}
function configured(core: Core) {
  core.installStarter();
  const config = core.state().state.config;
  config.models.push({ id: 'test-model', name: 'Test model', provider: 'openai' });
  config.bindings = core
    .state()
    .assets.filter((a) => a.type === 'role')
    .map((a) => ({ role: a.id, model: 'test-model', runtime: 'codex' }));
  core.updateConfig(config);
}
function advance(core: Core, run: Run): Run {
  const h = core.handoffPreview(run.id);
  const edge = h.possibleTransitions.find((e) => e.kind === 'advance');
  return core.transition(run.id, {
    expectedVersion: run.version,
    kind: edge ? 'advance' : 'complete',
    to: edge?.to,
    criteria: Object.fromEntries(h.completionCriteria.map((c) => [c, `Verified ${run.stage}`])),
    artifacts: Object.fromEntries(h.expectedOutput.map((a) => [a, `${a}@current`])),
  });
}

test('project-relative and absolute paths resolve identically, errors distinguish outside roots and ambiguous names', (t) => {
  const { root, core, save } = fixture(t);
  const dir = path.join(root, 'project');
  fs.mkdirSync(dir);
  const project = core.initProject({ root: dir, name: 'My project' });
  save({
    id: 'rule',
    type: 'rule',
    name: 'Rule',
    content: 'Apply me',
    scope: { directory: ['src'] },
  });
  const relative = core.preview({ context: { project: project.id, directory: 'src/components' } });
  const absolute = core.preview({
    context: { project: 'My project', directory: `${dir}/src/components` },
  });
  assert.deepEqual(relative, absolute);
  assert.match(
    core
      .preview({ context: { project: project.id, directory: 'test' } })
      .entries[0].reasons.join(' '),
    /directory.*src.*test/,
  );
  assert.throws(
    () => core.preview({ context: { project: project.id, directory: `${root}/elsewhere` } }),
    { code: 'DIRECTORY_OUTSIDE_PROJECT' },
  );
  assert.throws(() => core.preview({ context: { project: project.id, directory: '../escape' } }), {
    code: 'DIRECTORY_OUTSIDE_PROJECT',
  });
  const other = path.join(root, 'other');
  fs.mkdirSync(other);
  core.initProject({ root: other, name: 'My project' });
  assert.throws(() => core.startRun({ context: { project: 'My project' } }), {
    code: 'PROJECT_AMBIGUOUS',
  });
  assert.equal(
    normalizeDirectory('C:\\Work\\Repo\\SRC\\File', { ...project, root: 'C:\\Work\\Repo' }),
    'src/file',
  );
  assert.equal(
    normalizeDirectory('C:\\Work\\Repo\\src', {
      ...project,
      root: '/home/owner/repo',
      pathMappings: [{ from: 'C:/Work/Repo', to: '/home/owner/repo' }],
    }),
    'src',
  );
  assert.throws(() => normalizeDirectory('C:/Work/Repo/src', project), {
    code: 'DIRECTORY_MAPPING_REQUIRED',
  });
});

test('top-down role/model links deduplicate bodies; references/conditional links never escalate authority', (t) => {
  const { core, save } = fixture(t);
  configured(core);
  save({
    id: 'child',
    type: 'skill',
    name: 'Child',
    content: 'CHILD_UNIQUE_TEXT',
    scope: { model: ['test-model'] },
  });
  save({ id: 'reference', type: 'skill', name: 'Reference', content: 'EXCLUDED_REFERENCE_TEXT' });
  save({ id: 'conditional', type: 'skill', name: 'Conditional', content: 'CONDITION_ONLY_TEXT' });
  save({
    id: 'parent',
    type: 'skill',
    name: 'Parent',
    content:
      'Use `child` before starting.\nSee `reference` for details.\nWhen API changes, use `conditional`.\nNever use `reference` automatically.',
  });
  const role = core.state().assets.find((a) => a.id === 'orchestrator')!;
  save(
    {
      ...inputOf(role),
      relations: [
        { target: 'parent', kind: 'required', origin: 'manual', reason: 'User assigned' },
        { target: 'child', kind: 'required', origin: 'manual', reason: 'Shared across roles' },
      ],
    },
    role.revision,
  );
  const resolution = core.preview({
    context: { workflow: 'issue-development' },
    loadedSkills: ['parent', 'child'],
  });
  assert.equal(resolution.context.role, 'orchestrator');
  assert.equal(resolution.context.model, 'test-model');
  assert.equal(resolution.content.split('CHILD_UNIQUE_TEXT').length - 1, 1);
  assert.ok(!resolution.content.includes('EXCLUDED_REFERENCE_TEXT'));
  assert.ok(!resolution.content.includes('CONDITION_ONLY_TEXT'));
  assert.ok(
    resolution.entries
      .find((e) => e.asset.id === 'child')!
      .reasons.some((r) => r.includes('parent')),
  );
  assert.ok(
    resolution.entries
      .find((e) => e.asset.id === 'child')!
      .reasons.some((r) => r.includes('orchestrator')),
  );
  assert.throws(
    () =>
      save({
        id: 'bad',
        type: 'skill',
        name: 'Bad',
        relations: [
          {
            target: 'orchestrator',
            kind: 'required',
            origin: 'manual',
            reason: 'Try selecting upper role',
          },
        ],
      }),
    { code: 'RELATION_DIRECTION' },
  );
  assert.throws(
    () => save({ id: 'bad', type: 'skill', name: 'Bad', dependencies: ['orchestrator'] }),
    { code: 'RELATION_DIRECTION' },
  );
  const run = core.startRun({
    skillId: 'parent',
    context: { model: 'test-model', runtime: 'codex' },
  });
  assert.equal(run.context.role, undefined);
  assert.equal(run.context.model, 'test-model');
  assert.equal(run.mode, 'advisory');
});

test('editing skill text refreshes extracted links, preserves manual links and immutable snapshots; required cycles reject atomically', (t) => {
  const { core, save } = fixture(t);
  save({ id: 'b', type: 'skill', name: 'B', content: 'B' });
  save({ id: 'c', type: 'skill', name: 'C', content: 'C' });
  save({
    id: 'a',
    type: 'skill',
    name: 'A',
    content: 'Use `b`.',
    relations: [{ target: 'c', kind: 'reference', origin: 'manual', reason: 'Keep this source' }],
  });
  const run = core.startRun({ skillId: 'a' });
  const snapshot = core.getSnapshot(run.snapshotIds[0]);
  const a = core.state().assets.find((a) => a.id === 'a')!;
  save({ ...inputOf(a), content: 'Do not use `b`.' }, a.revision);
  assert.deepEqual(
    core
      .state()
      .assets.find((a) => a.id === 'a')!
      .relations?.map((r) => r.target),
    ['c'],
  );
  assert.deepEqual(core.getSnapshot(snapshot.id), snapshot);
  const preview = core.validateChanges({
    summary: 'cycle',
    operations: [
      {
        op: 'upsert',
        asset: assetSchema.parse({ id: 'a', name: 'A', type: 'skill', content: 'Use `b`.' }),
        expectedRevision: 2,
      },
    ],
  });
  assert.equal(preview.changes[0].after!.relations![0].target, 'b');
  assert.equal(core.state().assets.find((a) => a.id === 'a')!.revision, 2);
  core.changeAssets({
    summary: 'link',
    operations: [{ op: 'upsert', asset: inputOf(preview.changes[0].after!), expectedRevision: 2 }],
  });
  const b = core.state().assets.find((a) => a.id === 'b')!;
  assert.throws(() => save({ ...inputOf(b), content: 'Use `a`.' }, b.revision), {
    code: 'RELATION_CYCLE',
  });
  assert.equal(core.state().assets.find((a) => a.id === 'b')!.revision, 1);
});

test('last review can return to implementation, invalidates downstream evidence and completes after new review', (t) => {
  const { core } = fixture(t);
  configured(core);
  let run = core.startRun({ workflowId: 'issue-development' });
  while (run.stage !== 'code-review') run = advance(core, run);
  const snapshot = core.getSnapshot(run.snapshotIds.at(-1)!);
  const returned = core.transition(run.id, {
    expectedVersion: run.version,
    kind: 'return',
    to: 'implementation',
    note: 'Defect found',
    artifacts: { 'code-review': 'Rejected @v1' },
  });
  assert.equal(returned.artifacts['test-results'], undefined);
  assert.equal(returned.artifacts['pull-request'], undefined);
  assert.equal(returned.artifacts['code-review'], undefined);
  assert.ok(returned.artifacts.specification);
  assert.ok(
    !Object.keys(returned.criteria).some((k) =>
      /^(implementation|pull-request|code-review):/.test(k),
    ),
  );
  assert.ok(returned.events.at(-1)!.artifacts!['code-review']);
  assert.deepEqual(core.getSnapshot(snapshot.id), snapshot);
  run = returned;
  while (run.stage !== 'code-review') run = advance(core, run);
  const completed = advance(core, run);
  assert.equal(completed.status, 'completed');
  assert.ok(
    Object.values(completed.events.at(-1)!.criteria!).some((e) => e.includes('code-review')),
  );
  assert.equal(completed.events.at(-1)!.actor, 'runtime-report');
});

test('preflight and preview never mutate; retry IDs deduplicate and actual attempts differ from preparation', (t) => {
  const { core } = fixture(t);
  configured(core);
  const before = core.state();
  assert.equal(core.preflight({ workflowId: 'issue-development' }).ready, true);
  assert.deepEqual(core.state(), before);
  let run = core.startRun({ workflowId: 'issue-development', requestId: 'launch-1' });
  assert.equal(
    core.startRun({ workflowId: 'issue-development', requestId: 'launch-1' }).id,
    run.id,
  );
  assert.throws(
    () =>
      core.startRun({
        workflowId: 'issue-development',
        requestId: 'launch-1',
        instruction: 'different',
      }),
    { code: 'REQUEST_CONFLICT' },
  );
  const state = core.state();
  core.handoffPreview(run.id);
  core.handoffPreview(run.id);
  assert.deepEqual(core.state(), state);
  const handoff = core.handoff(run.id, { requestId: 'handoff-1', expectedVersion: run.version });
  assert.deepEqual(
    core.handoff(run.id, { requestId: 'handoff-1', expectedVersion: run.version }),
    handoff,
  );
  assert.equal(
    core.workflowMetrics().groups.reduce((n, g) => n + g.attempts, 0),
    0,
  );
  run = core.runtimeEvent(run.id, {
    event: 'started',
    expectedVersion: handoff.version,
    attemptId: 'attempt-1',
  });
  const started = core.runtimeEvent(run.id, {
    event: 'started',
    expectedVersion: handoff.version,
    attemptId: 'attempt-1',
  });
  assert.equal(started.version, run.version);
  assert.equal(started.attempts!.length, 1);
  assert.throws(
    () =>
      core.runtimeEvent(run.id, {
        event: 'started',
        expectedVersion: run.version,
        attemptId: 'attempt-2',
      }),
    { code: 'ATTEMPT_ACTIVE' },
  );
  run = core.runtimeEvent(run.id, {
    event: 'result',
    expectedVersion: run.version,
    attemptId: 'attempt-1',
    note: 'Complete brief',
    artifacts: { brief: 'brief@v1' },
  });
  const observedAt = new Date(Date.now() - 1000).toISOString();
  const journal = core.addJournal({
    snapshotId: started.attempts![0].snapshotId,
    attemptId: 'attempt-1',
    observedAt,
    kind: 'success',
    observation: 'Brief prepared',
  });
  assert.equal(journal.observedAt, observedAt);
  assert.throws(
    () =>
      core.addJournal({
        snapshotId: run.snapshotIds[0],
        attemptId: 'attempt-1',
        kind: 'defect',
        observation: 'Wrong stage evidence',
      }),
    { code: 'JOURNAL_ATTEMPT' },
  );
  const metrics = core.workflowMetrics();
  assert.equal(metrics.population.runs, 1);
  assert.equal(
    metrics.groups.reduce((n, g) => n + g.attempts, 0),
    1,
  );
  assert.equal(
    metrics.groups.reduce((n, g) => n + g.results, 0),
    1,
  );
  assert.equal(
    metrics.groups.reduce((n, g) => n + g.preparations, 0),
    2,
  );
});

test('restart pins the revised workflow and explicit artifacts without copying prior approval', (t) => {
  const { core, save } = fixture(t);
  configured(core);
  let run = core.startRun({ workflowId: 'issue-development' });
  run = advance(core, run);
  const original = core.getSnapshot(run.snapshotIds[0]);
  const workflow = core.state().assets.find((a) => a.id === 'issue-development')!;
  save({ ...inputOf(workflow), description: 'Revised workflow' }, workflow.revision);
  const restarted = core.restartRun(run.id, {
    expectedVersion: run.version,
    reuseArtifacts: ['brief'],
    reason: 'Use revised procedure',
  });
  assert.equal(restarted.workflow!.revision, 2);
  assert.equal(restarted.restartedFrom!.runId, run.id);
  assert.deepEqual(restarted.criteria, {});
  assert.deepEqual(restarted.artifacts, { brief: 'brief@current' });
  assert.equal(restarted.stage, 'intake');
  assert.deepEqual(core.getSnapshot(original.id), original);
  assert.equal(core.state().state.runs.find((r) => r.id === run.id)!.workflow!.revision, 1);
});

test('runtime enforcement is checked before handoff and snapshots preserve setting versions', (t) => {
  const { core, save } = fixture(t);
  configured(core);
  const workflow = core.state().assets.find((a) => a.id === 'issue-development')!;
  save(
    {
      ...inputOf(workflow),
      workflow: { ...workflow.workflow, requiredEnforcement: ['repository'] },
    },
    1,
  );
  assert.equal(core.preflight({ workflowId: workflow.id }).ready, false);
  const run = core.startRun({ workflowId: workflow.id });
  const original = core.getSnapshot(run.snapshotIds[0]);
  assert.throws(() => core.handoff(run.id, { action: 'development' }), {
    code: 'RUNTIME_ENFORCEMENT',
  });
  const config = core.state().state.config;
  config.runtimes.find((r) => r.id === 'codex')!.enforcement = {
    repository: 'enforced',
    external: 'instruction-only',
    tools: 'instruction-only',
  };
  core.updateConfig(config);
  assert.equal(core.preflight({ workflowId: workflow.id }).ready, true);
  const handoff = core.handoff(run.id, { action: 'development' });
  assert.equal(handoff.enforcement.repository, 'enforced');
  assert.deepEqual(core.getSnapshot(original.id), original);
  assert.notEqual(
    core.getSnapshot(handoff.snapshotId).settings!.version,
    original.settings!.version,
  );
  config.models[0].name = 'Later renamed model';
  core.updateConfig(config);
  assert.equal(core.handoffPreview(run.id).model!.name, 'Test model');
});

test('Journal review approval rejects newly extracted relation drift and preserves the presented diff', (t) => {
  const { core, save } = fixture(t);
  const run = core.startRun({});
  const journal = core.addJournal({
    snapshotId: run.snapshotIds[0],
    kind: 'improvement',
    observation: 'Need a skill',
  });
  const review = core.requestReview({ journalIds: [journal.id], reason: 'Create skill' });
  core.submitReview(review.id, {
    proposedBy: 'runtime',
    reason: 'Use known procedure',
    operations: [
      {
        op: 'upsert',
        asset: assetSchema.parse({ id: 'a', name: 'A', type: 'skill', content: 'Must use `b`.' }),
        expectedRevision: 0,
      },
    ],
  });
  const preview = core.reviewPreview(review.id);
  assert.equal(preview[0].after!.relations, undefined);
  save({ id: 'b', name: 'B', type: 'skill', content: 'B' });
  assert.throws(() => core.decideReview(review.id, true), { code: 'PROPOSAL_STALE' });
  assert.deepEqual(core.reviewPreview(review.id), preview);
  assert.ok(!core.state().assets.some((a) => a.id === 'a'));
  assert.equal(core.state().state.reviews[0].status, 'pending');
});

test('absolute directory relation conditions match relative conditions, and mixed execution cycles reject before commit', (t) => {
  const { root, core, save } = fixture(t);
  const projectRoot = path.join(root, 'project');
  fs.mkdirSync(projectRoot);
  const project = core.initProject({ root: projectRoot, name: 'Project' });
  save({ id: 'b', name: 'B', type: 'skill', content: 'B' });
  const relation = {
    target: 'b',
    kind: 'conditional',
    origin: 'manual',
    reason: 'Use in src',
    scope: { directory: [projectRoot + '/src'] },
  };
  save({ id: 'a', name: 'A', type: 'skill', content: 'A', relations: [relation] });
  assert.ok(
    core
      .preview({
        context: { project: project.id, directory: projectRoot + '/src/a' },
        requested: ['a'],
        loadedSkills: ['a'],
      })
      .skillCandidates?.some((a) => a.id === 'b'),
  );
  const a = core.state().assets.find((a) => a.id === 'a')!;
  save({ ...inputOf(a), relations: [], dependencies: ['b'] }, a.revision);
  const b = core.state().assets.find((a) => a.id === 'b')!;
  assert.throws(
    () =>
      save(
        {
          ...inputOf(b),
          relations: [{ target: 'a', kind: 'required', origin: 'manual', reason: 'Cycle' }],
        },
        b.revision,
      ),
    { code: 'RELATION_CYCLE' },
  );
  assert.equal(core.state().assets.find((a) => a.id === 'b')!.revision, 1);
});

test('a reported attempt may wait, resume and wait again; retries ignore object key ordering', (t) => {
  const { core } = fixture(t);
  configured(core);
  let run = core.startRun({ workflowId: 'issue-development' });
  const handoff = core.handoff(run.id, {});
  run = core.runtimeEvent(run.id, {
    expectedVersion: handoff.version,
    event: 'started',
    attemptId: 'a',
  });
  run = core.runtimeEvent(run.id, {
    expectedVersion: run.version,
    event: 'waiting-user',
    attemptId: 'a',
    note: 'First question',
  });
  run = core.runtimeEvent(run.id, {
    expectedVersion: run.version,
    event: 'resumed',
    attemptId: 'a',
    note: 'User answered',
  });
  assert.equal(run.executionStatus, 'running');
  run = core.runtimeEvent(run.id, {
    expectedVersion: run.version,
    event: 'waiting-user',
    attemptId: 'a',
    note: 'Second question',
  });
  run = core.runtimeEvent(run.id, {
    expectedVersion: run.version,
    event: 'resumed',
    attemptId: 'a',
  });
  const version = run.version;
  run = core.runtimeEvent(run.id, {
    expectedVersion: version,
    event: 'result',
    attemptId: 'a',
    requestId: 'report-1',
    artifacts: { patch: 'p1', tests: 't1' },
  });
  assert.equal(
    core.runtimeEvent(run.id, {
      expectedVersion: version,
      event: 'result',
      attemptId: 'a',
      requestId: 'report-1',
      artifacts: { tests: 't1', patch: 'p1' },
    }).version,
    run.version,
  );
  assert.equal(run.attempts!.length, 1);
  assert.equal(
    core.workflowMetrics().groups.reduce((n, g) => n + g.waitingUser, 0),
    2,
  );
});
