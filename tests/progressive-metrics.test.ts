import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Core } from '../server/core.ts';
import { Store } from '../server/store.ts';
import { assetSchema, inputOf } from '../server/domain.ts';
import { compareWorkflows } from '../server/observations.ts';

function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aacl-progressive-metrics-'));
  const store = new Store(root);
  const core = new Core(store);
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  core.changeAssets({
    summary: 'Workflow metrics fixture',
    operations: [
      { id: 'role', name: 'Worker', type: 'role', content: 'Perform the task.' },
      {
        id: 'workflow',
        name: 'Workflow',
        type: 'workflow',
        workflow: {
          developmentCapable: true,
          entryStage: 'work',
          entryRole: 'role',
          stages: [{ id: 'work', name: 'Work', role: 'role', canComplete: true }],
        },
      },
    ].map((asset) => ({ op: 'upsert', asset: assetSchema.parse(asset), expectedRevision: 0 })),
  });
  const config = core.state().state.config;
  config.models.push({ id: 'registered-model', name: 'Registered model', provider: 'openai' });
  core.updateConfig(config);
  const start = (model?: string) => {
    const run = core.startRun({ workflowId: 'workflow', context: { runtime: 'codex', model } });
    const handoff = core.handoff(run.id, {});
    return core.runtimeEvent(run.id, {
      event: 'started',
      expectedVersion: handoff.version,
      attemptId: 'attempt',
      actualModel: 'registered-model',
      actualRuntime: 'codex',
    });
  };
  return { core, start };
}

test('workflow metrics distinguish runtime-default and explicit requests for the same actual model', (t) => {
  const { core, start } = fixture(t);
  const defaultRun = start();
  start('registered-model');
  const snapshot = core.getSnapshot(defaultRun.attempts![0].snapshotId);
  assert.equal(snapshot.resolution.context.model, 'registered-model');
  assert.equal(snapshot.modelSelection?.policy, 'runtime-default');
  assert.equal(snapshot.modelSelection?.requestedModel, undefined);

  const before = core.state();
  const metrics = core.workflowMetrics({ workflowId: 'workflow' });
  const attempts = metrics.groups
    .filter((group) => group.attempts > 0)
    .sort((a, b) => (a.requestedModel ?? '').localeCompare(b.requestedModel ?? ''));
  assert.deepEqual(
    attempts.map(({ model, requestedModel, attempts, preparations }) => ({
      model,
      requestedModel,
      attempts,
      preparations,
    })),
    [
      { model: 'registered-model', requestedModel: null, attempts: 1, preparations: 0 },
      {
        model: 'registered-model',
        requestedModel: 'registered-model',
        attempts: 1,
        preparations: 0,
      },
    ],
  );
  assert.deepEqual(core.state(), before);
});

test('legacy snapshots without modelSelection retain context model fallback in workflow metrics', (t) => {
  const { core, start } = fixture(t);
  start();
  const legacy = core.state().state;
  for (const snapshot of legacy.snapshots) delete snapshot.modelSelection;
  const before = structuredClone(legacy);
  const metrics = compareWorkflows(legacy, { workflowId: 'workflow' });
  const attempts = metrics.groups.filter((group) => group.attempts > 0);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].model, 'registered-model');
  assert.equal(attempts[0].requestedModel, 'registered-model');
  assert.equal(attempts[0].attempts, 1);
  assert.deepEqual(legacy, before);
});

test('workflow comparisons separate candidate revisions and include subsequently retrieved dependencies', (t) => {
  const { core, start } = fixture(t);
  core.changeAssets({
    summary: 'progressive candidates',
    operations: [
      {
        id: 'candidate',
        name: 'Candidate',
        type: 'skill',
        description: 'Selected by Role',
        scope: { role: ['role'] },
        dependencies: ['detail'],
      },
      { id: 'detail', name: 'Detail', type: 'skill', activation: 'on-demand' },
    ].map((asset) => ({ op: 'upsert', expectedRevision: 0, asset: assetSchema.parse(asset) })),
  });
  start();
  const candidate = core.assetGet('candidate');
  core.changeAssets({
    summary: 'revise candidate',
    operations: [
      {
        op: 'upsert',
        expectedRevision: candidate.revision,
        asset: { ...inputOf(candidate), content: 'Updated procedure' },
      },
    ],
  });
  const second = start();
  const groups = core.workflowMetrics().groups.filter((g) => g.attempts);
  assert.equal(groups.length, 2);
  assert(groups.some((g) => g.assetRevisions.includes('candidate@1')));
  assert(groups.some((g) => g.assetRevisions.includes('candidate@2')));
  core.skillGet({
    id: 'detail',
    revision: 1,
    snapshotId: second.attempts![0].snapshotId,
    usage: 'use',
  });
  assert(
    core.workflowMetrics().groups.some((g) => g.attempts && g.assetRevisions.includes('detail@1')),
  );
});
