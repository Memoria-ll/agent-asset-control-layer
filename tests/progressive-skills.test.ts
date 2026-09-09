import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Core } from '../server/core.ts';
import { Store } from '../server/store.ts';
import { assetSchema, inputOf } from '../server/domain.ts';
import { Management } from '../server/management.ts';
import { assetBody } from '../server/contracts.ts';

function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aacl-progressive-'));
  const store = new Store(root),
    core = new Core(store);
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const save = (values: Record<string, unknown>[]) =>
    core.changeAssets({
      summary: 'test assets',
      operations: values.map((value) => ({
        op: 'upsert',
        asset: assetSchema.parse(value),
        expectedRevision: 0,
      })),
    });
  save([
    {
      id: 'role',
      name: 'Responsible role',
      type: 'role',
      content: 'ROLE_BODY',
      relations: [{ target: 'skill', kind: 'required', origin: 'manual', reason: 'role support' }],
    },
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
    {
      id: 'skill',
      name: 'Checklist',
      description: 'When reviewing a change',
      type: 'skill',
      content: 'SKILL_BODY_SENTINEL',
      dependencies: ['reference'],
      files: { 'helper.md': 'HELPER_BODY_SENTINEL' },
      skill: { completionCriteria: ['Skill checked'] },
    },
    {
      id: 'reference',
      name: 'Reference Skill',
      description: 'When extra checks are needed',
      type: 'skill',
      content: 'REFERENCE_BODY_SENTINEL',
    },
    {
      id: 'rule',
      name: 'Required rule',
      type: 'rule',
      content: 'RULE_BODY',
      scope: { role: ['role'] },
    },
  ]);
  return { core, store, save, root };
}

test('initial handoff contains deduplicated Skill descriptions without bodies, helpers or transitive injection', (t) => {
  const { core } = fixture(t);
  const before = core.state();
  assert.equal(
    core.preflight({ workflowId: 'workflow', context: { runtime: 'codex' } }).ready,
    true,
  );
  assert.deepEqual(core.state(), before);
  const run = core.startRun({ workflowId: 'workflow', context: { runtime: 'codex' } });
  const handoff = core.handoff(run.id, { action: 'development' });
  assert.equal(handoff.launch.modelPolicy, 'runtime-default');
  assert(!('model' in handoff.launch));
  assert(handoff.context.includes('ROLE_BODY'));
  assert(handoff.context.includes('RULE_BODY'));
  assert(handoff.context.includes('When reviewing a change'));
  assert.equal(handoff.skillCandidates.filter((s) => s.id === 'skill').length, 1);
  assert(!handoff.skillCandidates.some((s) => s.id === 'reference'));
  for (const secret of ['SKILL_BODY_SENTINEL', 'REFERENCE_BODY_SENTINEL', 'HELPER_BODY_SENTINEL']) {
    assert(!JSON.stringify(handoff).includes(secret));
    assert(!JSON.stringify(new Management(core).runGet(run.id)).includes(secret));
    assert(
      !JSON.stringify(
        new Management(core).resolve({ context: { workflow: 'workflow', runtime: 'codex' } }),
      ).includes(secret),
    );
  }
  assert(!handoff.completionCriteria.includes('Skill checked'));
});

test('runtime-default work starts with unknown or unregistered actual models and resolves registered child model conditions', (t) => {
  const { core, save } = fixture(t);
  const config = core.state().state.config;
  config.models.push({ id: 'child-model', name: 'Child', provider: 'openai' });
  core.updateConfig(config);
  save([
    {
      id: 'model-rule',
      type: 'rule',
      name: 'Child rule',
      content: 'CHILD_MODEL_RULE',
      scope: { model: ['child-model'] },
    },
  ]);
  for (const actualModel of [undefined, 'unregistered-model', 'child-model']) {
    const run = core.startRun({ workflowId: 'workflow', context: { runtime: 'codex' } });
    const handoff = core.handoff(run.id, {});
    const started = core.runtimeEvent(run.id, {
      event: 'started',
      attemptId: 'child',
      expectedVersion: handoff.version,
      actualModel,
    });
    assert.equal(started.attempts![0].requestedModel, undefined);
    assert.equal(started.attempts![0].actualModel, actualModel);
    const preview = core.handoffPreview(run.id);
    assert.equal(preview.actualModel, actualModel ?? null);
    assert.equal(preview.context.includes('CHILD_MODEL_RULE'), actualModel === 'child-model');
    assert.equal(preview.launch.modelPolicy, 'runtime-default');
    assert(!('model' in preview.launch));
    assert.notEqual(started.attempts![0].snapshotId, handoff.snapshotId);
    assert.equal(
      core.getSnapshot(handoff.snapshotId).resolution.content.includes('CHILD_MODEL_RULE'),
      false,
    );
  }
});

test('pinned Skill retrieval separates inspection from use and never expands reference bodies or helper files', (t) => {
  const { core } = fixture(t);
  const run = core.startRun({ workflowId: 'workflow', context: { runtime: 'codex' } });
  const handoff = core.handoff(run.id, {});
  const started = core.runtimeEvent(run.id, {
    event: 'started',
    attemptId: 'child',
    expectedVersion: handoff.version,
  });
  const snapshotId = started.attempts![0].snapshotId;
  const skill = core.assetGet('skill');
  core.changeAssets({
    summary: 'later edit',
    operations: [
      {
        op: 'upsert',
        expectedRevision: skill.revision,
        asset: { ...inputOf(skill), content: 'NEW_BODY' },
      },
    ],
  });
  const read = core.skillGet({ id: 'skill', revision: 1, snapshotId });
  assert.equal(read.asset.content, 'SKILL_BODY_SENTINEL');
  assert(!('files' in read.asset));
  assert(!JSON.stringify(read).includes('REFERENCE_BODY_SENTINEL'));
  assert(!JSON.stringify(read).includes('HELPER_BODY_SENTINEL'));
  assert.equal(read.references[0].id, 'reference');
  assert.equal(core.state().state.runs[0].skillReads![0].usedAt, undefined);
  core.skillGet({
    id: 'skill',
    revision: 1,
    snapshotId,
    usage: 'use',
    reason: 'Reviewing current change',
  });
  assert.equal(core.state().state.runs[0].skillReads!.length, 1);
  assert(core.state().state.runs[0].skillReads![0].usedAt);
  assert.equal(core.state().state.runs[0].version, started.version);
  assert(core.handoffPreview(run.id).completionCriteria.includes('Skill checked'));
  assert.equal(core.assetGet('skill', 1).files!['helper.md'], 'HELPER_BODY_SENTINEL');
  assert.throws(() => core.skillGet({ id: 'skill', revision: 2, snapshotId }));
});

test('explicit model precedence and unsupported selection are enforced atomically', (t) => {
  const { core } = fixture(t);
  const config = core.state().state.config;
  config.models.push(
    ...['role-model', 'stage-model', 'request-model'].map((id) => ({
      id,
      name: id,
      provider: 'openai',
    })),
  );
  config.bindings.push({ role: 'role', model: 'role-model', runtime: 'codex' });
  core.updateConfig(config);
  const workflow = core.assetGet('workflow');
  workflow.workflow!.stages[0].model = 'stage-model';
  core.changeAssets({
    summary: 'stage model',
    operations: [{ op: 'upsert', asset: inputOf(workflow), expectedRevision: workflow.revision }],
  });
  assert.equal(core.startRun({ workflowId: 'workflow' }).context.model, 'stage-model');
  const run = core.startRun({ workflowId: 'workflow', context: { model: 'request-model' } });
  const handoff = core.handoff(run.id, {});
  assert.equal(handoff.launch.model, 'request-model');
  const before = core.state();
  assert.throws(
    () =>
      core.runtimeEvent(run.id, {
        event: 'started',
        attemptId: 'wrong',
        expectedVersion: handoff.version,
        actualModel: 'role-model',
      }),
    { code: 'MODEL_MISMATCH' },
  );
  assert.deepEqual(core.state(), before);
  config.runtimes[0].supportsModelSelection = false;
  core.updateConfig(config);
  assert.equal(core.preflight({ workflowId: 'workflow' }).ready, false);
});

test('new Skill state machines are rejected while stored legacy data remains readable and non-executable', (t) => {
  const { core, store } = fixture(t);
  const skill = core.assetGet('skill');
  const legacy = {
    ...inputOf(skill),
    skill: { ...skill.skill!, steps: [{ skillId: 'reference' }] },
  };
  assert.throws(
    () =>
      core.changeAssets({
        summary: 'invalid structure',
        operations: [{ op: 'upsert', asset: legacy, expectedRevision: skill.revision }],
      }),
    { code: 'SKILL_ORCHESTRATION' },
  );
  store.transaction((_state, assets) =>
    Object.assign(
      assets.find((a) => a.id === skill.id)!,
      legacy,
    ),
  );
  assert.deepEqual(core.assetGet('skill').skill!.steps, [{ skillId: 'reference' }]);
  const preview = core.preview({ requested: ['skill'] });
  assert(!preview.content.includes('REFERENCE_BODY_SENTINEL'));
  assert.equal(core.skillGet({ id: 'aacl-asset-authoring', revision: 1 }).asset.type, 'skill');
  assert(core.preview({}).skillCandidates?.some((s) => s.id === 'aacl-asset-export'));
});

test('actual model constraints require evidence for exact selection and different reviewer models', (t) => {
  const { core } = fixture(t);
  const config = core.state().state.config;
  config.models.push({ id: 'model-a', name: 'A', provider: 'openai' });
  core.updateConfig(config);
  const workflow = core.assetGet('workflow');
  workflow.workflow!.stages = [
    {
      id: 'work',
      name: 'Work',
      role: 'role',
      requiredAssets: [],
      requiredCapabilities: [],
      completionCriteria: [],
      transitions: [{ to: 'review', kind: 'advance', requiredArtifacts: [] }],
      modelConstraint: { model: 'model-a' },
    },
    {
      id: 'review',
      name: 'Review',
      role: 'role',
      requiredAssets: [],
      requiredCapabilities: [],
      completionCriteria: [],
      transitions: [],
      canComplete: true,
      modelConstraint: { differentFromStage: 'work' },
    },
  ];
  core.changeAssets({
    summary: 'required model evidence',
    operations: [{ op: 'upsert', asset: inputOf(workflow), expectedRevision: workflow.revision }],
  });
  const run = core.startRun({ workflowId: 'workflow', context: { runtime: 'codex' } });
  const handoff = core.handoff(run.id, {});
  const before = core.state();
  assert.throws(
    () =>
      core.runtimeEvent(run.id, {
        event: 'started',
        attemptId: 'first',
        expectedVersion: handoff.version,
      }),
    { code: 'MODEL_CONSTRAINT_UNVERIFIED' },
  );
  assert.throws(
    () =>
      core.transition(run.id, { to: 'review', kind: 'advance', expectedVersion: handoff.version }),
    { code: 'MODEL_CONSTRAINT_UNVERIFIED' },
  );
  assert.deepEqual(core.state(), before);
  let current = core.runtimeEvent(run.id, {
    event: 'started',
    attemptId: 'first',
    expectedVersion: handoff.version,
    actualModel: 'model-a',
  });
  current = core.runtimeEvent(run.id, {
    event: 'result',
    attemptId: 'first',
    expectedVersion: current.version,
  });
  core.transition(run.id, { to: 'review', kind: 'advance', expectedVersion: current.version });
  const review = core.handoff(run.id, {});
  assert(!('model' in review.launch));
  assert.throws(
    () => core.transition(run.id, { kind: 'complete', expectedVersion: review.version }),
    { code: 'MODEL_CONSTRAINT_UNVERIFIED' },
  );
  for (const actualModel of [undefined, 'model-a']) {
    const beforeReview = core.state();
    assert.throws(
      () =>
        core.runtimeEvent(run.id, {
          event: 'started',
          attemptId: 'review',
          expectedVersion: review.version,
          actualModel,
        }),
      { code: 'MODEL_CONSTRAINT_UNVERIFIED' },
    );
    assert.deepEqual(core.state(), beforeReview);
  }
  current = core.runtimeEvent(run.id, {
    event: 'started',
    attemptId: 'review',
    expectedVersion: review.version,
    actualModel: 'unregistered-different-model',
  });
  assert.equal(current.attempts!.at(-1)!.actualModel, 'unregistered-different-model');
  assert.equal(core.handoffPreview(run.id).context.includes('model-a'), false);
});

test('runtime reports preserve the prepared project overlay after later settings edits', (t) => {
  const { core, root } = fixture(t);
  const project = core.initProject({ root, name: 'Pinned project' });
  const run = core.startRun({
    workflowId: 'workflow',
    context: { project: project.id, runtime: 'codex' },
  });
  const handoff = core.handoff(run.id, {});
  core.updateOverlay(project.id, { disabled: ['rule'], overrides: {}, bindings: {} });
  const started = core.runtimeEvent(run.id, {
    event: 'started',
    attemptId: 'child',
    expectedVersion: handoff.version,
  });
  assert(
    core.getSnapshot(started.attempts![0].snapshotId).resolution.content.includes('RULE_BODY'),
  );
  assert(core.handoffPreview(run.id).context.includes('RULE_BODY'));
  assert(
    !core
      .preview({ context: { project: project.id, workflow: 'workflow', runtime: 'codex' } })
      .content.includes('RULE_BODY'),
  );
});

test('Skill use accepted during preparation keeps obligations when runtime starts', (t) => {
  const { core } = fixture(t);
  const run = core.startRun({ workflowId: 'workflow', context: { runtime: 'codex' } });
  const handoff = core.handoff(run.id, {});
  core.skillGet({ id: 'skill', revision: 1, snapshotId: handoff.snapshotId, usage: 'use' });
  const started = core.runtimeEvent(run.id, {
    event: 'started',
    attemptId: 'child',
    expectedVersion: handoff.version,
  });
  assert(core.handoffPreview(run.id).completionCriteria.includes('Skill checked'));
  const before = core.state();
  assert.throws(
    () => core.transition(run.id, { kind: 'complete', expectedVersion: started.version }),
    { code: 'COMPLETION_CRITERIA' },
  );
  assert.deepEqual(core.state(), before);
  core.transition(run.id, {
    kind: 'complete',
    expectedVersion: started.version,
    criteria: { 'Skill checked': 'The selected procedure was checked' },
  });
});

test('Skill references use type-correct retrieval and transitive reads remain visible in metrics', (t) => {
  const { core } = fixture(t);
  const skill = core.assetGet('skill');
  core.changeAssets({
    summary: 'rule reference',
    operations: [
      {
        op: 'upsert',
        expectedRevision: skill.revision,
        asset: { ...inputOf(skill), dependencies: ['reference', 'rule'] },
      },
    ],
  });
  const run = core.startRun({ workflowId: 'workflow', context: { runtime: 'codex' } });
  const handoff = core.handoff(run.id, {});
  const read = core.skillGet({ id: 'skill', revision: 2, snapshotId: handoff.snapshotId });
  const rule = read.references.find((a) => a.id === 'rule')!;
  assert.equal(rule.retrieval.tool, 'aacl_asset_get');
  assert(!('snapshotId' in rule.retrieval.arguments));
  assert.equal(core.assetGet(rule.id, rule.revision).content, 'RULE_BODY');
  const ref = read.references.find((a) => a.id === 'reference')!;
  core.skillGet({ ...ref.retrieval.arguments, usage: 'use' });
  const metrics = core.assetMetrics().find((a) => a.assetId === 'reference')!;
  assert.equal(metrics.candidatePresentations, 0);
  assert.equal(metrics.retrieved, 1);
  assert.equal(metrics.reportedUses, 1);
  assert.equal(
    metrics.estimatedTokens,
    Math.ceil(assetBody(core.assetGet('reference')).length / 4),
  );
});
