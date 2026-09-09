import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Core } from '../server/core.ts';
import { Store } from '../server/store.ts';
import { assetSchema, inputOf, type Operation } from '../server/domain.ts';
import { Management, type Authorization } from '../server/management.ts';

const auth: Authorization = {
  userRequest: 'Create a reusable review procedure for my project.',
  actor: { kind: 'runtime', id: 'test-runtime', userId: 'alice' },
  reason: 'The user requested a reusable procedure.',
};
const operation = (id: string, content = 'Check the implementation.'): Operation => ({
  op: 'upsert',
  expectedRevision: 0,
  asset: assetSchema.parse({ id, name: id, type: 'rule', content }),
});
function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aacl-management-'));
  let store = new Store(path.join(dir, 'data'));
  const create = () => new Management(new Core(store));
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    management: create(),
    reopen: () => {
      store.close();
      store = new Store(path.join(dir, 'data'));
      return create();
    },
  };
}

test('direct proposals persist without Journals, expose concrete diff, and attribute approval to the requesting user', (t) => {
  const f = fixture(t);
  const pending = f.management.propose({ ...auth, operations: [operation('review-rule')] });
  assert.equal(pending.status, 'pending');
  assert.ok(pending.preview.changes[0].diff.content.lines.some((l) => l.kind === 'added'));
  assert.equal(f.management.core.state().assets.length, 0);
  assert.equal(f.management.core.state().state.journals.length, 0);
  assert.equal(f.management.core.state().state.runs.length, 0);
  const management = f.reopen();
  assert.deepEqual(management.proposalGet(pending.id), pending);
  const result = management.decideProposal(pending.id, {
    ...auth,
    decision: 'approve',
    userRequest: 'Apply the proposed review rule.',
  });
  assert.equal(result.proposal.status, 'approved');
  assert.equal(result.proposal.decision?.approvedBy, 'alice');
  const history = management.core.assetHistory('review-rule').changesets[0];
  assert.equal(history.actor, 'alice');
  assert.equal(history.userRequest, 'Apply the proposed review rule.');
  assert.equal(history.origin, 'user-request');
  assert.deepEqual(history.sourceJournals, []);
  assert.equal(management.proposalGet(pending.id).changeSetId, history.id);
  assert.throws(() => management.decideProposal(pending.id, { ...auth, decision: 'approve' }), {
    code: 'PROPOSAL_STATE',
  });
  assert.equal(f.reopen().proposalGet(pending.id).status, 'approved');
});

test('empty requests, approve booleans and runtime self-approval cannot authorize changes', (t) => {
  const { management } = fixture(t);
  const pending = management.propose({ ...auth, operations: [operation('bounded-rule')] });
  assert.throws(() => management.decideProposal(pending.id, { approve: true }));
  assert.throws(() =>
    management.decideProposal(pending.id, { ...auth, decision: 'approve', userRequest: ' ' }),
  );
  assert.throws(() =>
    management.decideProposal(pending.id, {
      ...auth,
      decision: 'approve',
      actor: { kind: 'runtime', id: 'model' },
    }),
  );
  assert.throws(() =>
    management.decideProposal(pending.id, {
      ...auth,
      decision: 'approve',
      actor: { kind: 'runtime', id: 'model', userId: 'model' },
    }),
  );
  assert.equal(management.proposalGet(pending.id).status, 'pending');
  assert.equal(management.core.state().assets.length, 0);
  const rejected = management.decideProposal(pending.id, {
    ...auth,
    decision: 'reject',
    userRequest: 'Do not add this rule.',
  });
  assert.equal(rejected.proposal.status, 'rejected');
  assert.equal(rejected.proposal.decision?.userRequest, 'Do not add this rule.');
  assert.equal(rejected.proposal.decision?.approvedBy, undefined);
  assert.equal(management.core.state().state.changesets.length, 0);
});

test('Core validation rejects invalid direct proposals without persisting partial changes', (t) => {
  const { management } = fixture(t);
  const invalid = operation('invalid');
  if (invalid.op === 'upsert') invalid.asset.dependencies = ['missing'];
  assert.throws(() => management.propose({ ...auth, operations: [operation('valid'), invalid] }), {
    code: 'REFERENCE',
  });
  assert.equal(management.proposals().total, 0);
  assert.equal(management.core.state().assets.length, 0);
});

test('stale asset approval and stale setting impact leave proposals pending and commit no partial assets', (t) => {
  const { management } = fixture(t);
  const pending = management.propose({
    ...auth,
    operations: [operation('first'), operation('second')],
  });
  management.core.changeAssets({
    operations: [operation('second', 'Different request')],
    summary: 'Concurrent change',
  });
  const before = management.core.state();
  assert.throws(() => management.decideProposal(pending.id, { ...auth, decision: 'approve' }), {
    code: 'REVISION_CONFLICT',
  });
  assert.deepEqual(management.core.state(), before);
  const next = management.propose({ ...auth, operations: [operation('third')] });
  management.updateConfig({ ...auth, config: management.config().config, expectedVersion: 0 });
  const beforeSettingsConflict = management.core.state();
  assert.throws(() => management.decideProposal(next.id, { ...auth, decision: 'approve' }), {
    code: 'PROPOSAL_STALE',
  });
  assert.deepEqual(management.core.state(), beforeSettingsConflict);
});

test('settings history and configuration save/restore are versioned, atomic and durable', (t) => {
  const f = fixture(t);
  let management = f.management;
  const initial = management.config();
  const config = structuredClone(initial.config);
  config.models.push({ id: 'test-model', name: 'Test model', provider: 'openai' });
  management.updateConfig({
    ...auth,
    config,
    expectedVersion: 0,
    reason: 'Register the user-selected model',
  });
  let history = management.settingsHistory().items;
  assert.equal(history[0].version, 1);
  assert.equal(history[0].actor, 'alice');
  assert.equal(history[0].userRequest, auth.userRequest);
  assert.deepEqual(history[0].before, initial.config);
  assert.deepEqual(history[0].after, config);
  const persisted = management.core.state();
  assert.throws(
    () => management.updateConfig({ ...auth, config: initial.config, expectedVersion: 0 }),
    { code: 'SETTINGS_CONFLICT' },
  );
  const invalid = structuredClone(config);
  invalid.models[0].provider = 'missing';
  assert.throws(() => management.updateConfig({ ...auth, config: invalid, expectedVersion: 1 }));
  assert.deepEqual(management.core.state(), persisted);
  management = f.reopen();
  management.restoreSettings({ ...auth, id: history[0].id, expectedVersion: 1, side: 'before' });
  assert.deepEqual(management.config().config, initial.config);
  history = management.settingsHistory().items;
  assert.equal(history.length, 2);
  assert.equal(history[0].version, 2);
  assert.equal(history[0].restoreOf, history[1].id);
  assert.deepEqual(f.reopen().settingsHistory().items, history);
});

test('overlay history restores editable fields and path mappings without rewriting past snapshots', (t) => {
  const { management, dir } = fixture(t);
  const root = path.join(dir, 'project');
  fs.mkdirSync(root);
  const project = management.initProject({ ...auth, root, name: 'Project' });
  management.core.changeAssets({
    operations: [operation('overlay-rule')],
    summary: 'Add shared rule',
  });
  const run = management.core.startRun({
    instruction: 'Inspect',
    context: { project: project.id },
  });
  const snapshot = management.core.getSnapshot(run.snapshotIds[0]);
  management.updateOverlay(project.id, {
    ...auth,
    expectedVersion: 0,
    overlay: {
      disabled: ['overlay-rule'],
      overrides: {},
      bindings: {},
      pathMappings: [{ from: 'C:/project', to: root }],
    },
  });
  const changed = management.settingsHistory({ kind: 'overlay', targetId: project.id }).items[0];
  assert.equal(changed.targetId, project.id);
  assert.equal(
    management.core
      .preview({ context: { project: project.id } })
      .assets.some((a) => a.id === 'overlay-rule'),
    false,
  );
  management.restoreSettings({ ...auth, id: changed.id, expectedVersion: 1 });
  const restored = management.core.state().state.projects[0];
  assert.deepEqual(restored.disabled, []);
  assert.deepEqual(restored.pathMappings, []);
  assert.deepEqual(management.core.getSnapshot(snapshot.id), snapshot);
  assert.equal(management.config().settingsVersion, 2);
});

test('Core callers also record setting history and rollback is attributed to the user', (t) => {
  const { management } = fixture(t);
  management.core.updateConfig(management.config().config);
  assert.equal(management.settingsHistory().items[0].actor, 'local-user');
  const change = management.changeAssets({ ...auth, operations: [operation('rollback-rule')] });
  const rolledBack = management.rollback({
    ...auth,
    changeSetId: change.proposal.changeSetId,
    userRequest: 'Undo that rule.',
  });
  assert.equal(rolledBack.actor, 'alice');
  assert.equal(rolledBack.userRequest, 'Undo that rule.');
  assert.equal(management.core.state().assets.length, 0);
  assert.throws(
    () => management.rollback({ ...auth, changeSetId: rolledBack.id, assetId: 'rollback-rule' }),
    { code: 'ROLLBACK_INPUT' },
  );
});

test('compact resolve excludes all excluded bodies and emits included text only once', (t) => {
  const { management } = fixture(t);
  const hidden = operation('hidden-rule', 'EXCLUDED_BODY_SENTINEL');
  if (hidden.op === 'upsert') {
    hidden.asset.scope = { role: ['different-role'] };
    hidden.asset.files = { 'references/private.md': 'EXCLUDED_FILE_SENTINEL' };
  }
  management.core.changeAssets({
    operations: [hidden, operation('included-rule', 'INCLUDED_BODY_SENTINEL')],
    summary: 'Context fixture',
  });
  const resolved = management.resolve({});
  const encoded = JSON.stringify(resolved);
  assert.equal(encoded.includes('EXCLUDED_BODY_SENTINEL'), false);
  assert.equal(encoded.includes('EXCLUDED_FILE_SENTINEL'), false);
  assert.equal(encoded.split('INCLUDED_BODY_SENTINEL').length - 1, 1);
  assert.ok(
    resolved.entries.some(
      (e) => e.id === 'hidden-rule' && e.status === 'excluded' && e.reasons.length,
    ),
  );
  assert.equal(JSON.stringify(management.assets()).includes('INCLUDED_BODY_SENTINEL'), false);
});

test('run/project/asset/Journal/review lists filter and paginate while run reads preserve snapshot and version', (t) => {
  const { management, dir } = fixture(t);
  const roots = ['one', 'two'].map((name) => {
    const root = path.join(dir, name);
    fs.mkdirSync(root);
    return root;
  });
  const projects = roots.map((root) =>
    management.initProject({ ...auth, name: 'Same display name', root }),
  );
  assert.equal(management.projects({ query: 'Same', limit: 1 }).nextOffset, 1);
  assert.equal(management.projects({ query: roots[1] }).items[0].id, projects[1].id);
  management.core.changeAssets({
    operations: [operation('a'), operation('b'), operation('c')],
    summary: 'List fixture',
  });
  assert.deepEqual(
    management.assets({ limit: 1, offset: 1 }).items.map((a) => a.id),
    ['b'],
  );
  assert.throws(() => management.assets({ limit: 101 }));
  const runs = projects.map((p) =>
    management.core.startRun({ instruction: 'Inspect', context: { project: p.id } }),
  );
  const before = management.core.state();
  const saved = management.runGet(runs[0].id);
  assert.equal(saved.version, 1);
  assert.equal(saved.handoffPreview?.preview, true);
  assert.equal(saved.handoffPreview?.snapshotId, runs[0].snapshotIds[0]);
  assert.deepEqual(management.core.state(), before);
  assert.equal(management.runs({ projectId: projects[0].id }).total, 1);
  const journal = management.core.addJournal({
    snapshotId: runs[0].snapshotIds[0],
    kind: 'improvement',
    observation: 'Need a clearer procedure',
  });
  assert.equal(management.journals({ projectId: projects[0].id }).items[0].id, journal.id);
  assert.equal(management.journals({ projectId: projects[1].id }).total, 0);
  const review = management.requestReview({ ...auth, journalIds: [journal.id] });
  assert.equal(review.requestedBy, 'alice');
  assert.equal(review.userRequest, auth.userRequest);
  assert.equal(management.reviews({ journalId: journal.id, status: 'awaiting-proposal' }).total, 1);
  management.core.submitReview(review.id, {
    proposedBy: 'test-runtime',
    reason: 'No changes needed',
    operations: [],
  });
  management.decideReview(review.id, { ...auth, decision: 'reject' });
  const recorded = management.core.reviewBundle(review.id).review;
  assert.equal(recorded.decision?.actor, 'alice');
  assert.equal(recorded.decision?.userRequest, auth.userRequest);
});

test('proposal preview includes Core-extracted relations and rejects later effective diff drift', (t) => {
  const { management } = fixture(t);
  management.core.changeAssets({
    summary: 'Reference target',
    operations: [
      {
        op: 'upsert',
        expectedRevision: 0,
        asset: assetSchema.parse({ id: 'target-skill', name: 'Target skill', type: 'skill' }),
      },
    ],
  });
  const proposal = management.propose({
    ...auth,
    operations: [
      {
        op: 'upsert',
        expectedRevision: 0,
        asset: assetSchema.parse({
          id: 'caller-skill',
          name: 'Caller skill',
          type: 'skill',
          content: 'Must use `target-skill` before proceeding.',
          sources: [{ host: 'test-host', path: '/skills/caller/SKILL.md', hash: 'source-hash' }],
        }),
      },
    ],
  });
  const validated = management.core.validateChanges({
    operations: proposal.operations,
    summary: proposal.reason,
  });
  assert.deepEqual(
    inputOf(proposal.preview.changes[0].after!),
    inputOf(validated.changes[0].after!),
  );
  assert.ok(proposal.preview.changes[0].after?.relations?.some((r) => r.target === 'target-skill'));
  // A new path match makes the formerly unique reference ambiguous without editing either proposal target.
  management.core.changeAssets({
    summary: 'Add independently imported skill',
    operations: [
      {
        op: 'upsert',
        expectedRevision: 0,
        asset: assetSchema.parse({
          id: 'other-target',
          name: 'Other target',
          type: 'skill',
          sources: [{ host: 'test-host', path: '/skills/caller/target-skill', hash: 'other-hash' }],
        }),
      },
    ],
  });
  assert.throws(() => management.decideProposal(proposal.id, { ...auth, decision: 'approve' }), {
    code: 'PROPOSAL_STALE',
  });
  assert.equal(management.proposalGet(proposal.id).status, 'pending');
  assert.equal(
    management.core.state().assets.some((a) => a.id === 'caller-skill'),
    false,
  );
});
