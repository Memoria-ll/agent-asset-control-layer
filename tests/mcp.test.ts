import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Store } from '../server/store.ts';
import { Core } from '../server/core.ts';
import { createApp, errorHandler } from '../server/app.ts';
import { DomainError } from '../server/domain.ts';

test('real HTTP MCP client: initialize, tools/resources, workflow, handoff, journal and proposal', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aacl-mcp-'));
  const store = new Store(dir);
  const core = new Core(store);
  core.installStarter();
  const app = createApp(core);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const client = new Client({ name: 'integration-test', version: '1' });
  t.after(async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const tools = await client.listTools();
  assert.ok(tools.tools.length >= 15);
  assert.equal(
    tools.tools.some((t) => t.name === 'aacl_review_decision'),
    true,
  );
  const resources = await client.listResources();
  assert.ok(resources.resources.some((r) => r.uri === 'aacl://bootstrap'));
  const read = await client.readResource({ uri: 'aacl://bootstrap' });
  assert.ok('text' in read.contents[0]);
  assert.match(read.contents[0].text, /Advisory/);
  assert.ok(read.contents[0].text.includes(`${base}/mcp`));
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    return JSON.parse((result.content as { text: string }[])[0].text);
  };
  assert.ok((await call('aacl_bootstrap', {})).content.includes(`${base}/mcp`));
  const generated = await call('aacl_materialize', { runtime: 'codex' });
  assert.ok(
    generated.files
      .find((f: any) => f.path === 'AACL-BOOTSTRAP.md')
      .content.includes(`${base}/mcp`),
  );
  assert.ok((await (await fetch(`${base}/api/bootstrap`)).text()).includes(`${base}/mcp`));
  let run = await call('aacl_session_start', {
    command: '/issue-development #100',
    instruction: 'Keep the requested directory.',
  });
  assert.equal(run.instruction, '#100\n\nKeep the requested directory.');
  assert.equal(run.stage, 'intake');
  const handoff = await call('aacl_context_handoff', {
    runId: run.id,
    action: 'development',
    delivery: 'runtime-pull',
    context: { runtime: 'codex' },
  });
  assert.equal(handoff.developmentAllowed, true);
  assert.equal(handoff.workflowRevision, 1);
  assert.equal(handoff.version, run.version + 1);
  assert.equal(handoff.task, run.instruction);
  assert.deepEqual(handoff.expectedOutput, ['brief']);
  const journal = await call('aacl_journal_append', {
    snapshotId: handoff.snapshotId,
    kind: 'missing-support',
    observation: 'The intake brief could be clearer.',
  });
  const stateResponse = await fetch(`${base}/api/state`);
  const state = (await stateResponse.json()) as any;
  const request = await fetch(`${base}/api/reviews`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-AACL-Token': state.humanToken },
    body: JSON.stringify({ journalIds: [journal.id], reason: 'User-triggered review' }),
  });
  assert.equal(request.status, 200);
  const review = (await request.json()) as any;
  const bundle = await call('aacl_review_get', { id: review.id });
  assert.equal(bundle.snapshots[0].workflowRevision, 1);
  const proposed = await call('aacl_review_submit', {
    id: review.id,
    reason: 'Add a bounded intake rule because the planning brief lacks a target.',
    proposedBy: 'test-runtime',
    operations: [
      {
        op: 'upsert',
        expectedRevision: 0,
        asset: {
          id: 'intake-guidance',
          type: 'rule',
          name: 'Intake guidance',
          content: 'Record the specific target in the intake brief.',
          scope: { workflow: ['issue-development'], stage: ['intake'] },
        },
      },
    ],
  });
  assert.equal(proposed.status, 'pending');
  assert.equal(
    core.state().assets.some((a) => a.id === 'intake-guidance'),
    false,
  );
  const decision = await fetch(`${base}/api/reviews/${review.id}/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-AACL-Token': state.humanToken },
    body: JSON.stringify({ approve: true }),
  });
  assert.equal(decision.status, 200);
  assert.ok(core.state().assets.some((a) => a.id === 'intake-guidance'));
  const nextReview = core.requestReview({
    journalIds: [journal.id],
    reason: 'Structured MCP review',
  });
  const nextProposal = await call('aacl_review_submit', {
    id: nextReview.id,
    reason: 'Clarify output',
    proposedBy: 'test-runtime',
    items: [
      {
        operation: {
          op: 'upsert',
          expectedRevision: 0,
          asset: {
            id: 'mcp-skill',
            name: 'MCP Skill',
            type: 'skill',
            skill: { completionCriteria: ['Checked'], expectedOutput: ['Report'] },
          },
        },
        proposedScope: {},
        proposedRelations: { dependencies: [], conflicts: [] },
        reason: 'An explicit output is needed',
        evidence: { journalIds: [journal.id], explanation: 'The intake report was missing' },
      },
    ],
  });
  assert.equal(nextProposal.items[0].evidenceMode, 'per-item');
  assert.ok(!core.state().assets.some((a) => a.id === 'mcp-skill'));
  const approved = await fetch(`${base}/api/reviews/${nextReview.id}/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-AACL-Token': state.humanToken },
    body: JSON.stringify({ approve: true }),
  });
  assert.equal(approved.status, 200);
  const history = await call('aacl_asset_history', { id: 'mcp-skill' });
  assert.equal(history.revisions[0].skill.completionCriteria[0], 'Checked');
  assert.equal(history.changesets[0].proposalItems[0].reason, 'An explicit output is needed');
  const diff = await call('aacl_asset_diff', { id: 'mcp-skill', from: 0, to: 1 });
  assert.ok(diff.fields.some((f: any) => f.path === 'skill'));
  const httpDiff = await fetch(`${base}/api/assets/mcp-skill/diff?from=0&to=1`);
  assert.deepEqual(await httpDiff.json(), diff);
  assert.equal((await fetch(`${base}/api/assets/mcp-skill/diff?from=missing&to=1`)).status, 400);
  const skillRun = await call('aacl_session_start', { skillId: 'mcp-skill' });
  const skillHandoff = await call('aacl_context_handoff', { runId: skillRun.id });
  assert.deepEqual(skillHandoff.expectedOutput, ['Report']);
  const noEvidence = await client.callTool({
    name: 'aacl_workflow_transition',
    arguments: { runId: skillRun.id, expectedVersion: 2, kind: 'complete' },
  });
  assert.equal(noEvidence.isError, true);
  await call('aacl_workflow_transition', {
    runId: skillRun.id,
    expectedVersion: 2,
    kind: 'complete',
    criteria: { Checked: 'Verified' },
    artifacts: { Report: 'report.md' },
  });
  const assetMetrics = await call('aacl_asset_metrics', {});
  assert.equal(assetMetrics.find((m: any) => m.assetId === 'mcp-skill').snapshots, 2);
  assert.deepEqual(await (await fetch(`${base}/api/metrics/assets`)).json(), assetMetrics);
  const advisory = await call('aacl_session_start', { command: 'Implement without a workflow' });
  const denied = await client.callTool({
    name: 'aacl_context_handoff',
    arguments: { runId: advisory.id, action: 'development' },
  });
  assert.equal(denied.isError, true);
  const missing = await client.callTool({ name: 'aacl_asset_get', arguments: { id: 'absent' } });
  assert.equal(missing.isError, true);
  // Stdio bridges the same live Core and must not acquire another store lock.
  for (const launch of [
    { command: process.execPath, args: ['--import', 'tsx', 'server/stdio.ts'] },
    { command: 'npm', args: ['--silent', 'run', 'mcp'] },
  ]) {
    const stdio = new Client({ name: 'stdio-test', version: '1' });
    const protocolErrors: Error[] = [];
    stdio.onerror = (error) => protocolErrors.push(error);
    await stdio.connect(
      new StdioClientTransport({
        ...launch,
        cwd: process.cwd(),
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              (pair): pair is [string, string] => pair[1] !== undefined,
            ),
          ),
          AACL_URL: `${base}/mcp`,
        },
        stderr: 'pipe',
      }),
    );
    try {
      const bootstrapResult = await stdio.callTool({ name: 'aacl_bootstrap', arguments: {} });
      assert.ok((bootstrapResult.content as { text: string }[])[0].text.includes(`${base}/mcp`));
      const runs = await stdio.callTool({ name: 'aacl_run_list', arguments: {} });
      assert.ok((runs.content as { text: string }[])[0].text.includes(run.id));
      assert.deepEqual(protocolErrors, [], 'stdio must contain only MCP protocol messages');
    } finally {
      await stdio.close();
    }
  }
});
test('HTTP rejects foreign Origin, host rebinding and unauthenticated human mutations', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aacl-http-'));
  const store = new Store(dir);
  const app = createApp(new Core(store));
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
  assert.equal(
    (await fetch(`${base}/api/state`, { headers: { Origin: 'https://untrusted.example' } })).status,
    403,
  );
  const foreignHost = await new Promise<number | undefined>((resolve, reject) => {
    http
      .get(`${base}/api/state`, { headers: { Host: 'untrusted.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      })
      .on('error', reject);
  });
  assert.equal(foreignHost, 403);
  assert.equal(
    (
      await fetch(`${base}/api/starter`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    403,
  );
  assert.equal((await fetch(`${base}/mcp`)).status, 405);
  assert.equal((await fetch(`${base}/api/unknown`)).status, 404);
});

test('MCP administration needs user attribution, shares UI setting history, and awaits asynchronous discovery', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aacl-mcp-admin-'));
  const root = path.join(dir, 'project');
  fs.mkdirSync(root);
  const store = new Store(path.join(dir, 'data'));
  const core = new Core(store);
  let discoveryFails = false;
  const discoveryResult = { checkedAt: '2026-09-09T00:00:00.000Z', sources: [] };
  const app = createApp(core, async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (discoveryFails)
      throw Object.assign(new DomainError('DISCOVERY_UNAVAILABLE', 'Runtime unavailable', 409), {
        details: { runtime: 'test-runtime', recoveryTool: 'aacl_model_discover' },
      });
    return discoveryResult;
  });
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = new Client({ name: 'admin-test', version: '1' });
  t.after(async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const call = async (name: string, args: Record<string, unknown> = {}, expectError = false) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(!!result.isError, expectError, JSON.stringify(result));
    const payload = (result.content as { text: string }[])[0].text;
    if (expectError && !payload.startsWith('{')) return { error: payload }; // SDK input-schema rejection.
    return JSON.parse(payload);
  };
  const auth = {
    actor: { kind: 'runtime', id: 'test-model', userId: 'alice' },
    userRequest: 'Set up this project and its review rule.',
    reason: 'User-requested project setup',
  };
  assert.deepEqual(await call('aacl_model_discover'), discoveryResult);
  discoveryFails = true;
  const error = await call('aacl_model_discover', {}, true);
  assert.equal(error.code, 'DISCOVERY_UNAVAILABLE');
  assert.deepEqual(error.details, { runtime: 'test-runtime', recoveryTool: 'aacl_model_discover' });
  const project = await call('aacl_project_initialize', { ...auth, root, name: 'User project' });
  assert.equal(
    (await call('aacl_project_list', { query: 'User project' })).items[0].id,
    project.id,
  );
  const config = (await call('aacl_config_get')).config;
  config.models.push({ id: 'test-model', name: 'Test model', provider: 'openai' });
  const configured = await call('aacl_config_update', { ...auth, config, expectedVersion: 0 });
  assert.equal(configured.settingsVersion, 1);
  assert.equal((await call('aacl_model_list', { provider: 'openai' })).items[0].id, 'test-model');
  const stale = await call('aacl_config_update', { ...auth, config, expectedVersion: 0 }, true);
  assert.equal(stale.code, 'SETTINGS_CONFLICT');
  assert.equal(stale.details.latestVersion, 1);
  const proposal = await call('aacl_asset_propose', {
    ...auth,
    operations: [
      {
        op: 'upsert',
        expectedRevision: 0,
        asset: {
          id: 'user-rule',
          type: 'rule',
          name: 'User rule',
          content: 'UNIQUE_INCLUDED_INSTRUCTION',
        },
      },
    ],
  });
  assert.equal(proposal.status, 'pending');
  assert.equal(core.state().state.journals.length, 0);
  await call('aacl_proposal_decision', { id: proposal.id, approve: true }, true);
  await call(
    'aacl_proposal_decision',
    { ...auth, id: proposal.id, decision: 'approve', actor: { kind: 'runtime', id: 'test-model' } },
    true,
  );
  const approved = await call('aacl_proposal_decision', {
    ...auth,
    id: proposal.id,
    decision: 'approve',
  });
  assert.equal(approved.changeSet.actor, 'alice');
  assert.equal(approved.proposal.decision.approvedBy, 'alice');
  assert.equal((await call('aacl_proposal_list', { status: 'approved' })).total, 1);
  assert.equal(
    (await call('aacl_asset_list', { query: 'user-rule', limit: 1 })).items[0].content,
    undefined,
  );
  const resolved = await call('aacl_context_resolve');
  assert.equal(JSON.stringify(resolved).split('UNIQUE_INCLUDED_INSTRUCTION').length - 1, 1);

  // Legacy UI bodies continue to work and write the same durable setting history.
  const state = (await (await fetch(`${base}/api/state`)).json()) as any;
  const ui = async (route: string, method: string, body: unknown) => {
    const result = await fetch(`${base}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-AACL-Token': state.humanToken },
      body: JSON.stringify(body),
    });
    assert.equal(result.status, 200, await result.clone().text());
    return result.json() as Promise<any>;
  };
  const sameProject = await ui('/api/projects', 'POST', { root, name: 'User project' });
  assert.equal(sameProject.id, project.id);
  await ui('/api/config', 'PUT', config);
  await ui(`/api/projects/${project.id}/overlay`, 'PUT', {
    disabled: ['user-rule'],
    overrides: {},
    bindings: {},
  });
  const history = await call('aacl_settings_history');
  assert.equal(history.items[0].actor, 'local-user');
  assert.equal(history.items[0].kind, 'overlay');
  assert.equal(history.items[1].actor, 'local-user');
  assert.equal(history.items[2].actor, 'alice');
  await call('aacl_settings_restore', { ...auth, id: history.items[0].id, expectedVersion: 3 });
  assert.deepEqual(core.state().state.projects[0].disabled, []);
  assert.equal(core.state().state.settingsVersion, 4);
  const rolledBack = await call('aacl_asset_rollback', {
    ...auth,
    changeSetId: approved.changeSet.id,
  });
  assert.equal(rolledBack.actor, 'alice');
  assert.equal(core.state().assets.length, 0);
});

test('MCP run reads do not mutate, conflicts expose latest run, and runtime/review recovery tools are usable', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aacl-mcp-recovery-'));
  const store = new Store(dir);
  const core = new Core(store);
  core.installStarter();
  const config = core.state().state.config;
  config.models.push({ id: 'test-model', name: 'Test model', provider: 'openai' });
  core.updateConfig(config);
  const app = createApp(core);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = new Client({ name: 'recovery-test', version: '1' });
  t.after(async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const call = async (name: string, args: Record<string, unknown> = {}, expectError = false) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(!!result.isError, expectError, JSON.stringify(result));
    const payload = (result.content as { text: string }[])[0].text;
    if (expectError && !payload.startsWith('{')) return { error: payload }; // SDK input-schema rejection.
    return JSON.parse(payload);
  };
  const auth = {
    actor: { kind: 'runtime', id: 'test-model', userId: 'alice' },
    userRequest: 'Review these observations.',
    reason: 'User-requested review',
  };
  const start = {
    workflowId: 'issue-development',
    instruction: 'Investigate issue',
    context: { runtime: 'codex', model: 'test-model' },
    requestId: 'start-request',
  };
  await call('aacl_session_preflight', start);
  assert.equal(core.state().state.runs.length, 0);
  const run = await call('aacl_session_start', start);
  const repeated = await call('aacl_session_start', start);
  assert.equal(repeated.id, run.id);
  assert.equal(core.state().state.runs.length, 1);
  const handoffInput = { runId: run.id, expectedVersion: 1, requestId: 'handoff-request' };
  const handoff = await call('aacl_context_handoff', handoffInput);
  assert.deepEqual(await call('aacl_context_handoff', handoffInput), handoff);
  const beforeRead = core.state();
  const read = await call('aacl_run_get', { runId: run.id });
  assert.equal(read.version, 2);
  assert.equal(read.handoffPreview.snapshotId, handoff.snapshotId);
  assert.equal(read.handoffPreview.preview, true);
  assert.equal(read.handoffRequests, undefined);
  assert.equal(
    (await call('aacl_context_handoff_preview', { runId: run.id })).snapshotId,
    handoff.snapshotId,
  );
  assert.equal(
    ((await (await fetch(`${base}/api/runs/${run.id}/handoff`)).json()) as any).preview,
    true,
  );
  assert.deepEqual(core.state(), beforeRead);
  const conflict = await call(
    'aacl_workflow_transition',
    { runId: run.id, expectedVersion: 1, kind: 'cancel' },
    true,
  );
  assert.equal(conflict.code, 'RUN_CONFLICT');
  assert.equal(conflict.latestRun.version, 2);
  assert.equal(conflict.recoveryTool, 'aacl_run_get');
  const started = await call('aacl_runtime_event', {
    runId: run.id,
    expectedVersion: 2,
    event: 'started',
    attemptId: 'attempt-one',
  });
  assert.equal(started.executionStatus, 'running');
  const observedAt = new Date().toISOString();
  const failed = await call('aacl_runtime_event', {
    runId: run.id,
    expectedVersion: 3,
    event: 'failed',
    attemptId: 'attempt-one',
    note: 'Runtime failed to produce the brief',
    observedAt,
  });
  assert.equal(failed.executionStatus, 'failed');
  const journal = await call('aacl_journal_append', {
    snapshotId: started.attempts[0].snapshotId,
    kind: 'defect',
    observation: 'The runtime failed',
    attemptId: 'attempt-one',
    observedAt,
  });
  assert.equal(journal.attemptId, 'attempt-one');
  assert.equal(journal.observedAt, observedAt);
  assert.equal((await call('aacl_journal_list', { runId: run.id })).items[0].id, journal.id);
  const review = await call('aacl_review_start', { ...auth, journalIds: [journal.id] });
  assert.equal(
    (await call('aacl_review_list', { workflowId: 'issue-development' })).items[0].id,
    review.id,
  );
  await call('aacl_review_submit', {
    id: review.id,
    reason: 'No asset change needed',
    proposedBy: 'test-model',
    items: [],
  });
  assert.deepEqual(await call('aacl_review_preview', { id: review.id }), []);
  await call('aacl_review_decision', { id: review.id, approve: true }, true);
  const decision = await call('aacl_review_decision', {
    ...auth,
    id: review.id,
    decision: 'approve',
  });
  assert.equal(decision.review.decision.actor, 'alice');
  assert.equal(decision.changeSet, undefined);
  const restarted = await call('aacl_run_restart', {
    runId: run.id,
    expectedVersion: 4,
    reuseArtifacts: [],
    reason: 'Retry with the current workflow',
  });
  assert.notEqual(restarted.id, run.id);
  assert.equal(restarted.restartedFrom.runId, run.id);
  const metrics = await call('aacl_workflow_metrics', { workflowId: 'issue-development' });
  assert.deepEqual(
    await (await fetch(`${base}/api/metrics/workflows?workflowId=issue-development`)).json(),
    metrics,
  );
});
