import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.ts';
import { Core } from '../server/core.ts';
import { assetSchema, inputOf } from '../server/domain.ts';
import { materialize } from '../server/adapters.ts';
import { lineDiff } from '../server/history.ts';

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aacl-contracts-'));
  const store = new Store(dir),
    core = new Core(store);
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const save = (value: Record<string, unknown>, revision = 0) =>
    core.changeAssets({
      summary: 'contract test',
      operations: [{ op: 'upsert', asset: assetSchema.parse(value), expectedRevision: revision }],
    });
  return { dir, store, core, save };
}

test('Skill/Role/Task Type contracts validate type and references and appear in real runtime context', (t) => {
  const { core, save } = fixture(t);
  assert.throws(
    () => assetSchema.parse({ id: 'wrong', type: 'rule', name: 'wrong', skill: {} }),
    /専用/,
  );
  assert.throws(
    () => save({ id: 'skill', name: 'Skill', type: 'skill', skill: { role: 'missing' } }),
    /参照先/,
  );
  save({
    id: 'reader',
    name: 'Reader',
    type: 'role',
    role: { responsibilities: ['Read evidence'], expectedOutput: ['Summary'] },
  });
  save({
    id: 'analysis',
    name: 'Analysis',
    type: 'task-type',
    taskType: {
      objective: 'Find causes',
      qualityCriteria: ['Cite sources'],
      constraints: ['No writes'],
    },
  });
  save({
    id: 'skill',
    name: 'Skill',
    type: 'skill',
    skill: {
      executionMode: 'standalone',
      role: 'reader',
      taskType: 'analysis',
      expectedOutput: ['Report'],
      completionCriteria: ['Evidence checked'],
    },
  });
  const run = core.startRun({ skillId: 'skill' });
  assert.equal(run.mode, 'advisory');
  assert.equal(run.context.role, 'reader');
  assert.equal(run.context.taskType, 'analysis');
  const handoff = core.handoff(run.id, {});
  for (const content of [
    'Read evidence',
    'Find causes',
    'Cite sources',
    'No writes',
    'Evidence checked',
    'read-only',
  ])
    assert.ok(handoff.context.includes(content), content);
  assert.deepEqual(handoff.expectedOutput, ['Report']);
  assert.equal(handoff.skill?.revision, 1);
  const file = materialize(core, { runtime: 'codex', requested: ['skill'] }).files.find((f) =>
    f.path.endsWith('/skill/SKILL.md'),
  )!;
  assert.match(file.content, /Expected output:\n- Report/);
  assert.throws(() => core.handoff(run.id, { action: 'development' }), /Development-capable/);
  assert.throws(
    () =>
      core.changeAssets({
        summary: 'delete referenced role',
        operations: [{ op: 'delete', id: 'reader', expectedRevision: 1 }],
      }),
    /参照先/,
  );
});

test('Standalone Skill pins its contract; completion requires evidence and artifacts, including on legacy runs', (t) => {
  const { core, save } = fixture(t);
  save({
    id: 'skill',
    name: 'Skill',
    type: 'skill',
    skill: { expectedOutput: ['Report'], completionCriteria: ['Checked'] },
  });
  const run = core.startRun({ skillId: 'skill' });
  const original = core.getSnapshot(run.snapshotIds[0]);
  save(
    {
      id: 'skill',
      name: 'Changed',
      type: 'skill',
      skill: {
        expectedOutput: ['Different'],
        completionCriteria: ['Different'],
        executionPermission: 'workflow-development',
      },
    },
    1,
  );
  // A pre-contract Run may not have its own pinned skill field; recover from its original Snapshot.
  core.store.transaction((s) => {
    delete s.runs[0].skill;
  });
  const handoff = core.handoff(run.id, {});
  assert.deepEqual(handoff.completionCriteria, ['Checked']);
  assert.equal(handoff.skill?.revision, 1);
  assert.deepEqual(core.getSnapshot(original.id), original);
  const version = core.state().state.runs[0].version;
  assert.throws(
    () => core.transition(run.id, { kind: 'complete', expectedVersion: version }),
    /完了条件/,
  );
  assert.throws(
    () =>
      core.transition(run.id, {
        kind: 'complete',
        expectedVersion: version,
        criteria: { Checked: 'Verified' },
      }),
    /成果物/,
  );
  assert.equal(core.state().state.runs[0].version, version);
  const completed = core.transition(run.id, {
    kind: 'complete',
    expectedVersion: version,
    criteria: { Checked: 'Verified' },
    artifacts: { Report: 'report.md' },
  });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.artifacts.Report, 'report.md');
  assert.equal(completed.criteria['skill:Checked'], 'Verified');
});

test('Skill mode/role/task/permission are enforced without bypassing mandatory or Workflow authorization', (t) => {
  const { core, save } = fixture(t);
  save({ id: 'reader', name: 'Reader', type: 'role' });
  save({ id: 'analysis', name: 'Analysis', type: 'task-type' });
  save({
    id: 'skill',
    name: 'Skill',
    type: 'skill',
    mandatory: true,
    skill: {
      executionMode: 'workflow',
      role: 'reader',
      taskType: 'analysis',
      executionPermission: 'workflow-development',
      expectedOutput: ['Report'],
      completionCriteria: ['Skill checked'],
    },
  });
  const workflow = (developmentCapable: boolean) => ({
    id: 'flow',
    name: 'Flow',
    type: 'workflow',
    workflow: {
      developmentCapable,
      entryStage: 'work',
      entryRole: 'reader',
      stages: [
        {
          id: 'work',
          name: 'Work',
          role: 'reader',
          taskType: 'analysis',
          requiredAssets: ['skill'],
          transitions: [],
        },
      ],
    },
  });
  save(workflow(false));
  assert.throws(() => core.startRun({ skillId: 'skill' }), /実行モード/);
  assert.throws(() => core.startRun({ workflowId: 'flow' }), /Development-capable/);
  save(workflow(true), 1);
  const run = core.startRun({ workflowId: 'flow' });
  assert.equal(core.handoff(run.id, { action: 'development' }).developmentAllowed, true);
  const version = core.state().state.runs[0].version;
  assert.throws(
    () => core.transition(run.id, { kind: 'complete', expectedVersion: version }),
    /Skill checked/,
  );
  assert.equal(
    core.transition(run.id, {
      kind: 'complete',
      expectedVersion: version,
      criteria: { 'Skill checked': 'done' },
      artifacts: { Report: 'report.md' },
    }).status,
    'completed',
  );
  const skill = core.state().assets.find((a) => a.id === 'skill')!;
  save(
    {
      ...inputOf(skill),
      skill: {
        ...skill.skill,
        taskType: undefined,
        role: undefined,
        executionPermission: 'read-only',
        executionMode: 'standalone',
      },
    },
    skill.revision,
  );
  assert.throws(() => core.startRun({ workflowId: 'flow' }), /実行モード/);
  assert.throws(
    () =>
      assetSchema.parse({
        id: 'bad',
        type: 'skill',
        name: 'Bad',
        skill: { executionMode: 'standalone', executionPermission: 'workflow-development' },
      }),
    /Workflow内/,
  );
});

test('Legacy assets, snapshots and history remain unchanged after reopening', (t) => {
  const { core, save, store, dir } = fixture(t);
  save({ id: 'legacy', name: 'Legacy', type: 'skill', content: 'Legacy text' });
  const run = core.startRun({ skillId: 'legacy' });
  const snapshot = core.getSnapshot(run.snapshotIds[0]);
  const history = core.assetHistory('legacy');
  store.close();
  const reopened = new Store(dir);
  try {
    const next = new Core(reopened);
    assert.equal(next.state().assets[0].skill, undefined);
    assert.deepEqual(next.getSnapshot(snapshot.id), snapshot);
    assert.deepEqual(next.assetHistory('legacy'), history);
    assert.equal(
      next.transition(run.id, { kind: 'complete', expectedVersion: 1 }).status,
      'completed',
    );
  } finally {
    reopened.close();
  }
});

test('Proposal items preserve per-change observed/proposed scopes, evidence and approved provenance', (t) => {
  const { core } = fixture(t);
  const run1 = core.startRun({ context: { team: 'one' } }),
    run2 = core.startRun({ context: { team: 'two' } });
  const j1 = core.addJournal({
    snapshotId: run1.snapshotIds[0],
    kind: 'missing-support',
    observation: 'First evidence',
  });
  const j2 = core.addJournal({
    snapshotId: run2.snapshotIds[0],
    kind: 'defect',
    observation: 'Second evidence',
  });
  const review = core.requestReview({ journalIds: [j1.id, j2.id], reason: 'Review' });
  const item = (id: string, journalId: string) => ({
    operation: {
      op: 'upsert',
      expectedRevision: 0,
      asset: { id, name: id, type: 'rule', scope: { team: ['broader'] } },
    },
    proposedScope: { team: ['broader'] },
    proposedRelations: { dependencies: [], conflicts: [] },
    reason: `Why ${id}`,
    evidence: { journalIds: [journalId], explanation: `Evidence for ${id}` },
  });
  const proposal = core.submitReview(review.id, {
    reason: 'Two changes',
    proposedBy: 'external',
    items: [item('first', j1.id), item('second', j2.id)],
  });
  assert.equal(core.state().assets.length, 0);
  assert.deepEqual(proposal.items?.[0].observedScopes, [{ team: 'one' }]);
  assert.deepEqual(proposal.items?.[1].observedScopes, [{ team: 'two' }]);
  assert.deepEqual(proposal.items?.[0].proposedScope, { team: ['broader'] });
  assert.deepEqual(proposal.items?.[0].evidence.snapshotIds, [j1.snapshotId]);
  assert.equal(proposal.items?.[0].evidenceMode, 'per-item');
  const approved = core.decideReview(review.id, true).changeSet!;
  assert.deepEqual(approved.proposalItems, proposal.items);
  assert.deepEqual(approved.sourceSnapshots, review.snapshotIds);
  assert.equal(approved.changes[0].proposalItemId, proposal.items![0].id);
  assert.deepEqual(approved.changes[0].kinds, ['added']);
  assert.deepEqual(core.assetHistory('first').changesets[0].proposalItems, proposal.items);
});

test('Proposal rejects fabricated evidence, mismatched scope/relations, ambiguous formats, and stale approval atomically', (t) => {
  const { core, save } = fixture(t);
  save({ id: 'rule', type: 'rule', name: 'Rule' });
  const run = core.startRun({});
  const journal = core.addJournal({
    snapshotId: run.snapshotIds[0],
    kind: 'defect',
    observation: 'Evidence',
  });
  const outside = core.addJournal({
    snapshotId: run.snapshotIds[0],
    kind: 'defect',
    observation: 'Outside',
  });
  const review = core.requestReview({ journalIds: [journal.id], reason: 'Review' });
  const proposal = {
    reason: 'Change',
    proposedBy: 'external',
    items: [
      {
        operation: {
          op: 'upsert',
          expectedRevision: 1,
          asset: { id: 'rule', type: 'rule', name: 'Updated', scope: { team: ['one'] } },
        },
        proposedScope: { team: ['one'] },
        proposedRelations: { dependencies: [], conflicts: [] },
        reason: 'Reason',
        evidence: { journalIds: [journal.id], snapshotIds: [], explanation: 'Evidence' },
      },
    ],
  };
  const invalid = (edit: (p: any) => void, pattern: RegExp) => {
    const p = structuredClone(proposal);
    edit(p);
    assert.throws(() => core.submitReview(review.id, p), pattern);
    assert.equal(core.state().state.reviews[0].status, 'awaiting-proposal');
    assert.equal(core.state().assets[0].revision, 1);
  };
  invalid((p) => (p.items[0].evidence.journalIds = [outside.id]), /対象外/);
  invalid((p) => (p.items[0].evidence.snapshotIds = ['invented']), /対象外/);
  invalid((p) => (p.items[0].proposedScope = {}), /一致/);
  invalid((p) => (p.items[0].proposedRelations.dependencies = ['rule']), /一致/);
  invalid((p) => (p.items[0].observedScopes = [{ team: 'made-up' }]), /Unrecognized/);
  invalid((p) => (p.operations = []), /片方/);
  core.submitReview(review.id, proposal);
  save({ id: 'rule', type: 'rule', name: 'Concurrent edit' }, 1);
  assert.throws(() => core.decideReview(review.id, true), /変更されています/);
  assert.equal(core.state().state.reviews[0].status, 'pending');
  assert.equal(core.state().state.changesets.length, 2);
});

test('No-change and legacy proposals remain supported with explicit evidence provenance', (t) => {
  const { core } = fixture(t);
  const run = core.startRun({});
  const j = core.addJournal({
    snapshotId: run.snapshotIds[0],
    kind: 'success',
    observation: 'Works',
  });
  const review = () => core.requestReview({ journalIds: [j.id], reason: 'Review' });
  const empty = review();
  core.submitReview(empty.id, { reason: 'Keep', proposedBy: 'external', items: [] });
  assert.equal(core.decideReview(empty.id, true).changeSet, undefined);
  const legacy = review();
  const p = core.submitReview(legacy.id, {
    reason: 'Legacy',
    proposedBy: 'external',
    operations: [
      { op: 'upsert', expectedRevision: 0, asset: { id: 'legacy', type: 'rule', name: 'Legacy' } },
    ],
  });
  assert.equal(p.items?.[0].evidenceMode, 'legacy-review');
  assert.deepEqual(p.items?.[0].evidence.journalIds, [j.id]);
});

test('Asset metrics use saved per-revision estimates and count only included assets', (t) => {
  const { core, save } = fixture(t);
  save({ id: 'cost', type: 'rule', name: 'Old name', content: 'abcd' });
  save({
    id: 'excluded',
    type: 'rule',
    name: 'Excluded',
    content: 'huge'.repeat(100),
    scope: { team: ['elsewhere'] },
  });
  const run = core.startRun({});
  core.handoff(run.id, {});
  const old = core.assetMetrics();
  assert.equal(old.length, 1);
  assert.equal(old[0].snapshots, 2);
  assert.equal(old[0].estimatedTokens, 2);
  save({ id: 'cost', type: 'rule', name: 'New name', content: 'abcd'.repeat(50) }, 1);
  assert.deepEqual(core.assetMetrics(), old);
  core.startRun({});
  const metrics = core.assetMetrics();
  assert.equal(metrics.length, 2);
  assert.equal(metrics.find((m) => m.assetRevision === 1)?.name, 'Old name');
  assert.equal(metrics.find((m) => m.assetRevision === 2)?.estimatedTokens, 50);
  assert.ok(metrics.every((m) => m.assetId !== 'excluded'));
});

test('History compares content and typed metadata across deletion, recreation and rollback', (t) => {
  const { core, save } = fixture(t);
  save({
    id: 'history',
    name: 'History',
    type: 'skill',
    content: 'one\ntwo\n',
    skill: { expectedOutput: ['Report'] },
  });
  save(
    {
      id: 'history',
      name: 'History',
      type: 'skill',
      content: 'one\nthree\n',
      scope: { team: ['one'] },
      skill: { expectedOutput: ['Report', 'Notes'] },
    },
    1,
  );
  const diff = core.assetDiff('history', { from: 1, to: 2 });
  assert.deepEqual(
    diff.content.lines.map((l) => l.kind),
    ['equal', 'removed', 'added'],
  );
  assert.ok(diff.fields.some((f) => f.path === 'skill.expectedOutput'));
  assert.ok(diff.fields.some((f) => f.path === 'scope.team'));
  core.changeAssets({
    summary: 'Delete',
    operations: [{ op: 'delete', id: 'history', expectedRevision: 2 }],
  });
  assert.equal(core.assetHistory('history').currentRevision, 0);
  assert.ok(
    core.assetDiff('history', { from: 2, to: 0 }).content.lines.every((l) => l.kind === 'removed'),
  );
  save({ id: 'history', name: 'Recreated', type: 'skill', content: 'new' });
  assert.deepEqual(
    core.assetHistory('history').revisions.map((a) => a.revision),
    [3, 2, 1],
  );
  core.rollback({ assetId: 'history', revision: 1, expectedRevision: 3 });
  assert.deepEqual(core.assetDiff('history', { from: 1, to: 4 }).fields, []);
  assert.throws(() => core.assetDiff('history', { from: 1, to: 999 }), /見つかりません/);
  assert.throws(() => core.assetDiff('history', { from: 0, to: 0 }), /少なくとも/);
});

test('Line diff preserves exact input including newline changes and bounds large comparisons', () => {
  const pairs = [
    ['', ''],
    ['a', 'a\n'],
    ['a\r\n', 'a\n'],
    ['one\ntwo\n', 'zero\none\nthree\n'],
    ['a\n'.repeat(1500), 'b\n'.repeat(1500)],
  ];
  for (const [a, b] of pairs) {
    const result = lineDiff(a, b);
    assert.equal(
      result.lines
        .filter((l) => l.kind !== 'added')
        .map((l) => l.text)
        .join(''),
      a,
    );
    assert.equal(
      result.lines
        .filter((l) => l.kind !== 'removed')
        .map((l) => l.text)
        .join(''),
      b,
    );
  }
  assert.equal(lineDiff(pairs[4][0], pairs[4][1]).coarse, true);
});
