import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.ts';
import { Core } from '../server/core.ts';
import { assetSchema, inputOf } from '../server/domain.ts';
import { materialize } from '../server/adapters.ts';

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aacl-first-use-test-'));
  const store = new Store(path.join(dir, 'data'));
  const core = new Core(store);
  core.installStarter();
  const root = path.join(dir, 'project');
  fs.mkdirSync(root);
  const project = core.initProject({ root, name: 'Trial project' });
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { core, project };
}

test('slash commands preserve instructions and handoff exposes immutable project facts and usable version', (t) => {
  const { core, project } = fixture(t);
  for (const args of [
    { command: '/issue-development', instruction: 'Work in the registered folder.' },
    { workflowId: 'issue-development', instruction: 'Work in the registered folder.' },
    { command: '/issue-development Work in the registered folder.' },
  ]) {
    const run = core.startRun({ ...args, context: { project: project.id } });
    assert.equal(run.instruction, 'Work in the registered folder.');
    assert.equal(run.lastHandoff, undefined);
    const initial = core.getSnapshot(run.snapshotIds[0]);
    const handoff = core.handoff(run.id, { action: 'development' });
    assert.deepEqual(handoff.project, { id: project.id, name: project.name, root: project.root });
    assert.equal(handoff.task, run.instruction);
    assert.equal(handoff.version, run.version + 1);
    assert.deepEqual(core.getSnapshot(initial.id), initial);
    assert.equal(
      core.state().state.runs.find((r) => r.id === run.id)?.lastHandoff?.delivery,
      'runtime-pull',
    );
    const retrievedAt = core.state().state.runs.find((r) => r.id === run.id)?.runtimeHandoffAt;
    assert.ok(retrievedAt);
    assert.throws(
      () =>
        core.transition(run.id, {
          kind: 'advance',
          to: 'specification',
          expectedVersion: run.version,
        }),
      /更新/,
    );
    const moved = core.transition(run.id, {
      kind: 'advance',
      to: 'specification',
      expectedVersion: handoff.version,
      criteria: Object.fromEntries(
        handoff.completionCriteria.map((c) => [c, 'Verified against issue.']),
      ),
      artifacts: { brief: 'docs/brief.md' },
    });
    assert.equal(moved.stage, 'specification');
    assert.equal(moved.lastHandoff, undefined);
    assert.equal(moved.runtimeHandoffAt, undefined);
    const manual = core.handoff(run.id, { delivery: 'host-inject' });
    assert.equal(
      core.state().state.runs.find((r) => r.id === run.id)?.lastHandoff?.snapshotId,
      manual.snapshotId,
    );
    assert.deepEqual(core.getSnapshot(initial.id), initial);
    core.handoff(run.id, {});
    const acquired = core.state().state.runs.find((r) => r.id === run.id)?.runtimeHandoffAt;
    core.handoff(run.id, { delivery: 'host-inject' });
    assert.equal(core.state().state.runs.find((r) => r.id === run.id)?.runtimeHandoffAt, acquired);
  }
  const plain = core.startRun({ instruction: 'Investigate' });
  assert.equal(core.handoff(plain.id, {}).project, null);
  const skill = core.startRun({
    command: '/security-review inline scope',
    instruction: 'Extra constraint',
  });
  assert.equal(core.handoff(skill.id, {}).task, 'inline scope\n\nExtra constraint');
  assert.throws(
    () => core.startRun({ command: '/security-review', workflowId: 'issue-development' }),
    /同時/,
  );
  const bundle = materialize(core, {
    runtime: 'codex',
    context: { project: project.id, workflow: 'issue-development' },
  });
  assert.ok(
    bundle.files
      .find((f) => f.path === '.agents/skills/issue-development/SKILL.md')
      ?.content.includes(JSON.stringify({ project: project.id })),
  );
});

test('starter reviews keep standalone authority and enforce evidence and outputs without choosing a role', (t) => {
  const { core } = fixture(t);
  const bodies = new Set<string>();
  for (const id of [
    'refactoring-review',
    'architecture-review',
    'security-review',
    'test-review',
  ]) {
    const run = core.startRun({ skillId: id });
    const handoff = core.handoff(run.id, {});
    assert.equal(handoff.role, null);
    assert.equal(handoff.developmentAllowed, false);
    assert.ok(!handoff.assets.some((a) => a.type === 'role'));
    bodies.add(core.state().assets.find((a) => a.id === id)!.content);
    assert.throws(
      () => core.transition(run.id, { kind: 'complete', expectedVersion: handoff.version }),
      /根拠/,
    );
    const completed = core.transition(run.id, {
      kind: 'complete',
      expectedVersion: handoff.version,
      criteria: Object.fromEntries(
        handoff.completionCriteria.map((c) => [c, 'Read code and checked references.']),
      ),
      artifacts: Object.fromEntries(handoff.expectedOutput.map((name) => [name, `${id}.md`])),
    });
    assert.equal(completed.status, 'completed');
  }
  assert.equal(bodies.size, 4);
  assert.ok(!core.diagnostics().some((d) => d.id.startsWith('dup-')));
  const handoff = core.handoff(core.startRun({ workflowId: 'issue-development' }).id, {});
  assert.deepEqual(handoff.expectedOutput, ['brief']);
  assert.ok(handoff.context.includes('受け入れ条件: 名前あり・なし'));
});

test('proposal scope errors explain project normalization and preview compares the submitted base revision', (t) => {
  const { core, project } = fixture(t);
  const run = core.startRun({ context: { project: project.id } });
  const journal = core.addJournal({
    snapshotId: run.snapshotIds[0],
    kind: 'improvement',
    observation: 'Need a local rule.',
  });
  const review = core.requestReview({ journalIds: [journal.id], reason: 'Author project rule' });
  const input = {
    reason: 'Explicit guidance',
    proposedBy: 'test',
    items: [
      {
        operation: {
          op: 'upsert',
          expectedRevision: 0,
          asset: {
            id: 'local-rule',
            name: 'Local rule',
            type: 'rule',
            projectId: project.id,
            content: 'New text',
          },
        },
        proposedScope: {} as { project?: string[] },
        proposedRelations: { dependencies: [], conflicts: [] },
        reason: 'Record project practice',
        evidence: {
          journalIds: [journal.id],
          explanation: 'The observation describes missing guidance.',
        },
      },
    ],
  };
  assert.throws(
    () => core.submitReview(review.id, input),
    (e: Error) =>
      e.message.includes('proposedScope.project') &&
      e.message.includes(project.id) &&
      e.message.includes('入力値'),
  );
  assert.equal(core.state().state.reviews[0].status, 'awaiting-proposal');
  input.items[0].proposedScope = { project: [project.id] };
  core.submitReview(review.id, input);
  const preview = core.reviewPreview(review.id)[0];
  assert.equal(preview.before, null);
  assert.deepEqual(preview.after?.scope.project, [project.id]);
  assert.equal(preview.diff.content.lines[0].kind, 'added');
  core.decideReview(review.id, true);
  const asset = core.state().assets.find((a) => a.id === 'local-rule')!;
  const revision = core.requestReview({ journalIds: [journal.id], reason: 'Update text' });
  core.submitReview(revision.id, {
    reason: 'More detail',
    proposedBy: 'test',
    operations: [
      {
        op: 'upsert',
        expectedRevision: asset.revision,
        asset: { ...inputOf(asset), content: 'Proposed text' },
      },
    ],
  });
  core.changeAssets({
    summary: 'Concurrent human edit',
    operations: [
      {
        op: 'upsert',
        expectedRevision: asset.revision,
        asset: assetSchema.parse({ ...inputOf(asset), content: 'Later human text' }),
      },
    ],
  });
  const fixedBase = core.reviewPreview(revision.id)[0];
  assert.equal(fixedBase.before?.content, 'New text');
  assert.equal(fixedBase.after?.content, 'Proposed text');
  assert.throws(() => core.decideReview(revision.id, true), /変更されています/);
});
