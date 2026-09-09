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
    tools.tools.some((t) => /approve|decision|rollback/.test(t.name)),
    false,
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
  const stdio = new Client({ name: 'stdio-test', version: '1' });
  await stdio.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'server/stdio.ts'],
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
  } finally {
    await stdio.close();
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
