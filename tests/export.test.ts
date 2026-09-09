import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  assetSchema,
  configSchema,
  defaultConfig,
  inputOf,
  type Asset,
  type State,
} from '../server/domain.ts';
import { builtinSkills } from '../server/builtin-skills.ts';
import { exportBundle, exportInputSchema } from '../server/export.ts';

const timestamp = '2026-09-09T00:00:00.000Z';
const asset = (input: Record<string, unknown>, revision = 1): Asset => ({
  ...assetSchema.parse(input),
  revision,
  updatedAt: timestamp,
});
function fixture() {
  const assets: Asset[] = [
    asset({
      id: 'implementer',
      name: 'Implementer',
      type: 'role',
      content: 'Implement the requested change.',
      role: {
        responsibilities: ['Implement within the requested scope'],
        expectedOutput: ['patch'],
      },
      relations: [
        {
          target: 'implementation',
          kind: 'required',
          origin: 'manual',
          reason: 'Relevant procedure',
        },
      ],
    }),
    asset({
      id: 'reviewer',
      name: 'Reviewer',
      type: 'role',
      content: 'Review the actual patch.',
      relations: [
        { target: 'review-checks', kind: 'required', origin: 'manual', reason: 'Review procedure' },
      ],
    }),
    asset({
      id: 'implementation',
      name: 'Implementation checks',
      type: 'skill',
      activation: 'on-demand',
      description: 'Use when implementing a bounded change.',
      content: 'Read [the checklist](references/check.md).',
      files: {
        'references/check.md': 'Check against [the example](sample.txt).',
        'references/sample.txt': 'EXAMPLE_BYTES\n',
        'scripts/helper.sh': '#!/bin/sh\nprintf check\n',
      },
      relations: [
        {
          target: 'review-checks',
          kind: 'reference',
          origin: 'manual',
          reason: 'Understand review criteria',
        },
      ],
    }),
    asset({
      id: 'review-checks',
      name: 'Review checks',
      type: 'skill',
      activation: 'on-demand',
      description: 'Use when reviewing changes.',
      content: 'Compare the patch with the requested result.',
      relations: [
        {
          target: 'implementation',
          kind: 'reference',
          origin: 'manual',
          reason: 'Understand implementation context',
        },
      ],
    }),
    asset({
      id: 'implementation-rule',
      name: 'Implementation rule',
      type: 'rule',
      content: 'Run the relevant tests.',
      scope: { role: ['implementer'] },
    }),
    asset({
      id: 'unrelated-private-rule',
      name: 'Private rule',
      type: 'rule',
      content: 'UNRELATED_PRIVATE_BODY',
      scope: { role: ['other-role'] },
    }),
    asset({
      id: 'unrelated-capability',
      name: 'Private connector',
      type: 'capability',
      content: 'UNRELATED_CAPABILITY_BODY',
      capability: {
        provider: 'private-provider',
        tools: ['private-tool'],
        connected: false,
        allowed: false,
      },
    }),
    asset(
      {
        id: 'development',
        name: 'Development',
        type: 'workflow',
        description: 'Implement, review and return failures.',
        content: 'Keep the user-selected working directory. SOURCE_WORKFLOW_REQUIREMENT',
        workflow: {
          developmentCapable: true,
          entryStage: 'implement',
          entryRole: 'implementer',
          completionCriteria: ['User request addressed'],
          stages: [
            {
              id: 'implement',
              name: 'Implement',
              role: 'implementer',
              expectedOutput: ['patch'],
              completionCriteria: ['Tests pass'],
              transitions: [{ to: 'review', kind: 'advance', requiredArtifacts: ['patch'] }],
            },
            {
              id: 'review',
              name: 'Review',
              role: 'reviewer',
              canComplete: true,
              expectedOutput: ['review-report'],
              completionCriteria: ['Reviewed current patch'],
              transitions: [{ to: 'implement', kind: 'return' }],
            },
          ],
        },
      },
      4,
    ),
  ];
  const state: State = {
    schemaVersion: 1,
    projects: [],
    config: structuredClone(defaultConfig),
    runs: [],
    snapshots: [],
    journals: [],
    changesets: [],
    reviews: [],
    settingsVersion: 7,
  };
  state.config.providers.push({ id: 'private-provider', name: 'UNRELATED_PROVIDER' });
  state.config.accounts.push({
    id: 'private-account',
    name: 'UNRELATED_ACCOUNT',
    provider: 'private-provider',
  });
  state.config.models.push({
    id: 'private-model',
    name: 'UNRELATED_MODEL',
    provider: 'private-provider',
    account: 'private-account',
  });
  state.config.runtimes.push({
    id: 'private-runtime',
    name: 'UNRELATED_RUNTIME',
    provider: 'private-provider',
    endpoint: 'http://private.internal/SECRET',
  });
  state.config.bindings.push({
    role: 'other-role',
    model: 'private-model',
    runtime: 'private-runtime',
  });
  let reads = 0;
  return {
    assets,
    state,
    get reads() {
      return reads;
    },
    core: {
      state: () => {
        reads++;
        return { state, assets };
      },
    },
  };
}
const request = { assetIds: ['development'], mode: 'standalone', runtime: 'codex' } as const;
const standalone = (f: ReturnType<typeof fixture>) =>
  exportBundle(f.core, { ...request, assetIds: [...request.assetIds] });

test('built-in authoring/export skills have fixed immutable revisioned bodies and shared classification guidance', () => {
  assert.deepEqual(
    builtinSkills.map((a) => a.id),
    ['aacl-asset-authoring', 'aacl-asset-export'],
  );
  for (const skill of builtinSkills) {
    assert.equal(skill.type, 'skill');
    assert.equal(skill.revision, 1);
    assert.equal(skill.updatedAt, timestamp);
    assert.equal(skill.activation, 'on-demand');
    assert.deepEqual(skill.scope, {});
    assert.match(skill.description, /advisory consultation/);
    assert.equal(skill.workflow, undefined);
    assert.equal(Object.hasOwn(skill.skill!, 'steps'), false);
    assert.equal(Object.hasOwn(skill.skill!, 'role'), false);
    assetSchema.parse(inputOf(skill));
  }
  assert.equal(
    builtinSkills[0].files!['references/classification.md'],
    builtinSkills[1].files!['references/classification.md'],
  );
  assert.match(
    builtinSkills[0].files!['references/classification.md'],
    /generated artifact may orchestrate; its authoring Skill does not/,
  );
  assert.match(builtinSkills[1].content, /aacl_export_bundle/);
  assert.match(builtinSkills[1].files!['references/output-contract.md'], /existing\s+file diffs/);
  assert.throws(() => {
    builtinSkills[0].description = 'Mutated';
  }, TypeError);
  assert.throws(() => {
    builtinSkills[0].files!['references/classification.md'] = 'Mutated';
  }, TypeError);
  assert.throws(() => {
    builtinSkills.push(builtinSkills[0]);
  }, TypeError);
});

test('one immutable snapshot supplies the full typed closure and excludes unrelated config and asset bodies', () => {
  const f = fixture();
  const before = structuredClone({ state: f.state, assets: f.assets });
  const bundle = standalone(f);
  assert.equal(f.reads, 1);
  assert.deepEqual(
    bundle.assets.map((a) => a.id),
    [
      'development',
      'implementation',
      'implementation-rule',
      'implementer',
      'review-checks',
      'reviewer',
    ],
  );
  assert.equal(bundle.manifest.settingsVersion, 7);
  assert.equal(bundle.assets.find((a) => a.id === 'development')!.revision, 4);
  assert.equal(bundle.config.models.length, 0);
  assert.equal(bundle.config.accounts.length, 0);
  assert.equal(bundle.config.bindings.length, 0);
  assert.equal(JSON.stringify(bundle).includes('UNRELATED_'), false);
  assert.equal(JSON.stringify(bundle).includes('private.internal'), false);
  assert.deepEqual({ state: f.state, assets: f.assets }, before);
  assert.throws(() => {
    bundle.assets[0].content = 'Mutated';
  }, TypeError);
  assert.throws(() => {
    bundle.files[0].content = 'Mutated';
  }, TypeError);
  f.assets.find((a) => a.id === 'development')!.revision = 5;
  f.state.settingsVersion = 8;
  assert.equal(bundle.assets.find((a) => a.id === 'development')!.revision, 4);
  assert.equal(bundle.manifest.settingsVersion, 7);
});

test('standalone Workflow contains actual local orchestration, output guards, returns and no MCP launcher', () => {
  const bundle = standalone(fixture());
  const map = bundle.manifest.assets.find((a) => a.id === 'development')!;
  const file = bundle.files.find((f) => f.path === map.entry)!;
  assert.match(file.path, /^\.agents\/skills\/a-development-.*\/SKILL.md$/);
  assert.match(file.content, /Delegate, wait, inspect, and transition/);
  assert.match(file.content, /Reviewed current patch/);
  assert.match(file.content, /User request addressed/);
  assert.match(file.content, /SOURCE_WORKFLOW_REQUIREMENT/);
  assert.match(file.content, /"kind":"return"/);
  assert.match(file.content, /Model unspecified: omit the model argument/);
  assert.equal(file.content.includes('aacl_session_start'), false);
  assert.equal(file.content.includes('aacl_context_handoff'), false);
  assert.equal(bundle.outputSpecifications.requiresCore, false);
  assert.equal(bundle.ready, true);
  assert.ok(bundle.files.some((f) => f.path === 'aacl-export/workflow-runtime.mjs'));
  const index = JSON.parse(
    bundle.files.find((f) => f.path === 'aacl-export/asset-index.json')!.content,
  );
  assert.ok(
    index.some(
      (a: { id: string; description: string }) => a.id === 'implementation' && a.description,
    ),
  );
  assert.equal(
    index.some((a: object) => Object.hasOwn(a, 'content') || Object.hasOwn(a, 'files')),
    false,
  );
  const implementation = bundle.manifest.assets.find((a) => a.id === 'implementation')!;
  const helper = bundle.files.find((f) => f.path.endsWith('/scripts/helper.sh'))!;
  assert.equal(helper.content, '#!/bin/sh\nprintf check\n');
  assert.ok(implementation.files.includes(helper.path));
  assert.equal(bundle.assets.find((a) => a.id === 'development')!.type, 'workflow');
});

function helperRunner(t: TestContext, bundle: ReturnType<typeof exportBundle>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aacl-export-helper-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'workflow-runtime.mjs');
  fs.writeFileSync(
    file,
    bundle.files.find((f) => f.path === 'aacl-export/workflow-runtime.mjs')!.content,
  );
  const definition = bundle.assets.find((a) => a.id === 'development')!.workflow!;
  return (request: unknown) =>
    JSON.parse(
      execFileSync(process.execPath, [file], {
        input: JSON.stringify({ definition, request }),
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
}

test('generated standalone helper runs offline and requires fresh evidence after return before completion', (t) => {
  const run = helperRunner(t, standalone(fixture()));
  let state = run({ action: 'start' });
  assert.equal(state.stage, 'implement');
  assert.throws(() =>
    run({
      state,
      expectedVersion: 1,
      kind: 'advance',
      to: 'review',
      artifacts: { patch: 'patch-r1.diff' },
    }),
  );
  state = run({
    state,
    expectedVersion: 1,
    kind: 'advance',
    to: 'review',
    artifacts: { patch: 'patch-r1.diff' },
    criteria: { 'Tests pass': 'tests log r1' },
  });
  assert.equal(state.stage, 'review');
  assert.throws(() =>
    run({ state, expectedVersion: 1, kind: 'return', to: 'implement', reason: 'Fix defect' }),
  );
  assert.throws(() => run({ state, expectedVersion: 2, kind: 'return', to: 'implement' }));
  state = run({ state, expectedVersion: 2, kind: 'return', to: 'implement', reason: 'Fix defect' });
  assert.deepEqual(state.evidence, {});
  assert.equal(state.artifacts.patch, undefined);
  assert.throws(() =>
    run({
      state,
      expectedVersion: 3,
      kind: 'advance',
      to: 'review',
      criteria: { 'Tests pass': 'old tests' },
    }),
  );
  state = run({
    state,
    expectedVersion: 3,
    kind: 'advance',
    to: 'review',
    artifacts: { patch: 'patch-r2.diff' },
    criteria: { 'Tests pass': 'tests log r2' },
  });
  assert.throws(() =>
    run({
      state,
      expectedVersion: 4,
      kind: 'complete',
      artifacts: { 'review-report': 'report.md' },
      criteria: { 'Reviewed current patch': 'patch r2 reviewed' },
    }),
  );
  state = run({
    state,
    expectedVersion: 4,
    kind: 'complete',
    artifacts: { 'review-report': 'report.md' },
    criteria: {
      'Reviewed current patch': 'patch r2 reviewed',
      'User request addressed': 'verified against request',
    },
  });
  assert.equal(state.status, 'completed');
  assert.equal(state.artifacts.patch, 'patch-r2.diff');
  assert.equal(state.events.length, 4);
});

test('manifest pins all files with actual digests, stable identity and collision-safe native names', () => {
  const f = fixture();
  f.assets.push(
    asset({ id: 'CON', name: 'CON', type: 'skill' }),
    asset({ id: 'con', name: 'con', type: 'skill' }),
  );
  const input = { assetIds: ['development', 'CON', 'con'], mode: 'standalone', runtime: 'claude' };
  const first = exportBundle(f.core, input);
  const second = exportBundle(f.core, input);
  assert.deepEqual(first, second);
  assert.equal(f.reads, 2);
  assert.equal(new Set(first.files.map((f) => f.path.toLowerCase())).size, first.files.length);
  assert.ok(
    first.manifest.assets
      .filter((a) => ['CON', 'con'].includes(a.id))
      .every((m) => m.entry.startsWith('.claude/skills/')),
  );
  for (const entry of first.manifest.files) {
    const file = first.files.find((f) => f.path === entry.path)!;
    assert.equal(entry.sha256, createHash('sha256').update(file.content).digest('hex'));
    assert.equal(entry.bytes, Buffer.byteLength(file.content));
  }
  assert.equal(first.manifest.files.length, first.files.length - 1);
  assert.deepEqual(
    JSON.parse(first.files.find((f) => f.path === 'aacl-export/manifest.json')!.content),
    first.manifest,
  );
});

test('explicit stage and binding models remain explicit; enforcement, capability and model constraints are reported', () => {
  const f = fixture();
  const workflow = f.assets.find((a) => a.workflow)!;
  workflow.workflow!.stages[0].model = 'stage-model';
  workflow.workflow!.stages[1].modelConstraint = { differentFromStage: 'implement' };
  workflow.workflow!.stages[1].requiredCapabilities = ['unrelated-capability'];
  workflow.workflow!.requiredEnforcement = ['repository'];
  f.state.config.bindings.push({ role: 'implementer', model: 'role-default', runtime: 'codex' });
  f.state.config.models.push(
    { id: 'stage-model', name: 'Stage model', provider: 'openai' },
    { id: 'role-default', name: 'Role default', provider: 'openai' },
  );
  const bundle = standalone(f);
  const entry = bundle.files.find(
    (f) => f.path === bundle.manifest.assets.find((a) => a.id === 'development')!.entry,
  )!;
  assert.match(entry.content, /Explicit model: "stage-model"/);
  assert.equal(bundle.ready, false);
  assert.ok(bundle.limitations.some((l) => l.code === 'ENFORCEMENT_UNSUPPORTED'));
  assert.ok(bundle.limitations.some((l) => l.code === 'CAPABILITY_REQUIRES_SETUP'));
  assert.ok(bundle.limitations.some((l) => l.code === 'MODEL_CONSTRAINT_REQUIRES_VERIFICATION'));
  assert.deepEqual(
    bundle.config.models.map((m) => m.id),
    ['stage-model', 'role-default'],
  );
  const explicit = exportBundle(f.core, {
    ...request,
    assetIds: ['development'],
    context: { model: 'user-model' },
  });
  assert.match(
    explicit.files.find(
      (f) => f.path === explicit.manifest.assets.find((a) => a.id === 'development')!.entry,
    )!.content,
    /Explicit model: "user-model"/,
  );
  assert.ok(explicit.limitations.some((l) => l.code === 'MODEL_SELECTION_UNVERIFIED'));
});

test('connected output is distinguished from standalone and runtime layout is selected explicitly', () => {
  const f = fixture();
  const connected = exportBundle(f.core, {
    assetIds: ['development'],
    mode: 'connected',
    runtime: 'cursor',
  });
  const entry = connected.files.find(
    (f) => f.path === connected.manifest.assets.find((a) => a.id === 'development')!.entry,
  )!;
  assert.match(entry.path, /^\.cursor\/skills\//);
  assert.match(entry.content, /requires a running AACL Core/);
  assert.match(entry.content, /aacl_session_start/);
  assert.equal(connected.outputSpecifications.requiresCore, true);
  assert.equal(
    connected.files.some((f) => f.path === 'aacl-export/workflow-runtime.mjs'),
    false,
  );
  const generic = exportBundle(f.core, {
    assetIds: ['implementation'],
    mode: 'standalone',
    runtime: 'generic',
  });
  assert.ok(
    generic.manifest.assets.find((a) => a.id === 'implementation')!.entry.startsWith('skills/'),
  );
});

test('source runtime endpoints never leak through standalone or connected bundles', () => {
  for (const endpoint of [
    'https://native.example/mcp?token=FAKE_SECRET',
    'https://user:FAKE_SECRET@native.example/mcp',
    'https://native.example/mcp#FAKE_SECRET',
    'https://native.example/FAKE_SECRET/mcp',
  ]) {
    for (const mode of ['standalone', 'connected'] as const) {
      const f = fixture();
      f.state.config.runtimes.find((r) => r.id === 'codex')!.endpoint = endpoint;
      configSchema.parse(f.state.config);
      const before = structuredClone(f.state);
      const bundle = exportBundle(f.core, { ...request, mode });
      assert.equal(JSON.stringify(bundle).includes('FAKE_SECRET'), false);
      assert.equal(bundle.config.runtimes.find((r) => r.id === 'codex')!.endpoint, undefined);
      const settings = JSON.parse(
        bundle.files.find((f) => f.path === 'aacl-export/settings.json')!.content,
      );
      assert.equal(
        settings.config.runtimes.find((r: { id: string }) => r.id === 'codex').endpoint,
        undefined,
      );
      assert.ok(bundle.limitations.some((l) => l.code === 'RUNTIME_ENDPOINT_OMITTED'));
      assert.equal(bundle.ready, mode === 'standalone');
      assert.deepEqual(f.state, before);
    }
  }
});

test('reference-style Markdown links include and rewrite asset targets in bodies and helper files', () => {
  for (const content of [
    'Read [check][ref].\n\n[ref]: ../review/SKILL.md\n',
    'Read [ref][].\n\n[ref]: <../review/SKILL.md#criteria> "Checklist title"\n',
    'Read [ref].\n\n[ref]:\n  ../review/SKILL.md\n',
    '> Read [check][ref].\n>\n> [ref]: ../review/SKILL.md\n',
  ]) {
    const f = fixture();
    const caller = f.assets.find((a) => a.id === 'implementation')!;
    caller.relations = [];
    caller.content = content;
    caller.sources = [
      { host: 'source-host', path: '/source/implementation/SKILL.md', hash: 'source' },
    ];
    caller.files!['references/check.md'] = 'Read [check][ref].\n\n[ref]: ../../review/SKILL.md\n';
    f.assets.find((a) => a.id === 'review-checks')!.sources = [
      { host: 'source-host', path: '/source/review/SKILL.md', hash: 'source' },
    ];
    const bundle = exportBundle(f.core, { ...request, assetIds: ['implementation'] });
    const entry = bundle.manifest.assets.find((a) => a.id === 'implementation')!;
    const target = bundle.manifest.assets.find((a) => a.id === 'review-checks');
    assert.ok(target);
    for (const output of [
      entry.entry,
      entry.files.find((p) => p.endsWith('/references/check.md'))!,
    ]) {
      const text = bundle.files.find((f) => f.path === output)!.content;
      const relative = path.posix.relative(path.posix.dirname(output), target.entry);
      assert.ok(
        text.includes(
          `[ref]: ${content.includes('<') && output === entry.entry ? '<' : ''}${relative}`,
        ) || text.includes(`[ref]:\n  ${relative}`),
        text,
      );
      assert.equal(text.includes('../review/SKILL.md'), false);
    }
    if (content.includes('Checklist title'))
      assert.ok(
        bundle.files
          .find((f) => f.path === entry.entry)!
          .content.includes('#criteria> "Checklist title"'),
      );
    assert.equal(bundle.ready, true, JSON.stringify(bundle.limitations));
  }
});

test('unavailable and ambiguous reference-style destinations block usable export', () => {
  const f = fixture();
  const caller = f.assets.find((a) => a.id === 'implementation')!;
  caller.relations = [];
  caller.content = 'Read [required][ref].\n\n[ref]: <../missing/SKILL.md> "Required"\n';
  caller.sources = [
    { host: 'source-host', path: '/source/implementation/SKILL.md', hash: 'source' },
  ];
  for (const ambiguous of [false, true]) {
    if (ambiguous) {
      for (const id of ['target-one', 'target-two'])
        f.assets.push(
          asset({
            id,
            name: id,
            type: 'skill',
            activation: 'on-demand',
            sources: [{ host: 'source-host', path: '/source/missing/SKILL.md', hash: 'source' }],
          }),
        );
    }
    const bundle = exportBundle(f.core, { ...request, assetIds: ['implementation'] });
    assert.equal(bundle.ready, false);
    assert.ok(
      bundle.limitations.some(
        (l) => l.code === 'UNRESOLVED_LOCAL_REFERENCE' && l.assetId === caller.id,
      ),
    );
  }
});

test('generated validator rejects changes to earlier artifacts and preserves earlier proofs when later outputs are added', (t) => {
  const run = helperRunner(t, standalone(fixture()));
  const state = run({
    state: run({ action: 'start' }),
    expectedVersion: 1,
    kind: 'advance',
    to: 'review',
    artifacts: { patch: 'patch-v1.diff' },
    criteria: { 'Tests pass': 'tests passed for patch-v1' },
  });
  const complete = {
    state,
    expectedVersion: 2,
    kind: 'complete',
    artifacts: { patch: 'patch-v2.diff', 'review-report': 'report.md' },
    criteria: {
      'Reviewed current patch': 'review proof',
      'User request addressed': 'request proof',
    },
  };
  assert.throws(() => run(complete), /Return.*artifact/i);
  const completed = run({
    ...complete,
    artifacts: { patch: 'patch-v1.diff', 'review-report': 'report.md' },
  });
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.evidence.implement, state.evidence.implement);
  assert.equal(completed.evidence.review.artifacts.patch, 'patch-v1.diff');
  assert.equal(state.status, 'active');
});

test('document references extend the closure and rewrite local cross-asset references while preserving helpers', () => {
  const f = fixture();
  const caller = f.assets.find((a) => a.id === 'implementation')!;
  caller.relations = [];
  caller.sources = [
    { host: 'source-host', path: '/source/implementation/SKILL.md', hash: 'source' },
  ];
  caller.content =
    'Read [review](../review/SKILL.md), [the rule](aacl://assets/implementation-rule@1), and [spaced helper](references/a%20b.md).';
  caller.files!['references/a b.md'] = 'Preserve the helper filename.';
  const reviewer = f.assets.find((a) => a.id === 'review-checks')!;
  reviewer.sources = [{ host: 'source-host', path: '/source/review/SKILL.md', hash: 'source' }];
  const bundle = exportBundle(f.core, {
    assetIds: ['implementation'],
    mode: 'standalone',
    runtime: 'generic',
  });
  const entry = bundle.files.find(
    (f) => f.path === bundle.manifest.assets.find((a) => a.id === caller.id)!.entry,
  )!;
  assert.equal(entry.content.includes('aacl://'), false);
  assert.equal(entry.content.includes('../review/SKILL.md'), false);
  assert.ok(bundle.assets.some((a) => a.id === 'implementation-rule'));
  assert.ok(bundle.assets.some((a) => a.id === 'review-checks'));
  assert.equal(bundle.ready, true, JSON.stringify(bundle.limitations));
});

test('missing references, unsafe colliding helper paths, and stale embedded revisions cannot silently produce usable output', () => {
  const f = fixture();
  const source = f.assets.find((a) => a.id === 'implementation')!;
  source.dependencies.push('absent');
  assert.throws(() => standalone(f), { code: 'EXPORT_REFERENCE' });
  source.dependencies = [];
  source.content = '[Old rule](aacl://assets/implementation-rule@999)';
  assert.throws(() => standalone(f), { code: 'EXPORT_REFERENCE_REVISION' });
  source.content = '[Missing helper](references/absent.md)';
  assert.equal(standalone(f).ready, false);
  source.content = 'Call aacl_context_handoff to receive live context.';
  assert.ok(standalone(f).limitations.some((l) => l.code === 'LIVE_CORE_REFERENCE'));
  source.content = 'Offline procedure';
  source.files = { 'scripts/live.py': 'call_tool("aacl_asset_get", {"id": "implementation"})' };
  assert.ok(
    standalone(f).limitations.some(
      (l) => l.code === 'LIVE_CORE_REFERENCE' && l.path?.endsWith('live.py'),
    ),
  );
  source.files = { 'SKILL.md': 'entry replacement' };
  assert.throws(() => standalone(f), { code: 'EXPORT_PATH_CONFLICT' });
  source.files = { references: 'file', 'references/check.md': 'impossible descendant' };
  assert.throws(() => standalone(f), { code: 'EXPORT_PATH_CONFLICT' });
  source.files = { '../escape': 'unsafe' };
  assert.throws(() => standalone(f));
  assert.throws(() =>
    exportInputSchema.parse({
      assetIds: ['development', 'development'],
      mode: 'standalone',
      runtime: 'codex',
    }),
  );
});
