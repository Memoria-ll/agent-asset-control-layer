import { test, expect, type Page } from '@playwright/test';
import { assetSchema, inputOf, type AssetInput } from '../../server/domain.ts';

async function state(page: Page) {
  return (await page.request.get('/api/state')).json();
}
async function write(page: Page, route: string, data: unknown) {
  const current = await state(page);
  const response = await page.request.post(`/api${route}`, {
    data,
    headers: { 'X-AACL-Token': current.humanToken },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function assets(page: Page, inputs: Partial<AssetInput>[]) {
  return write(page, '/assets/change', {
    summary: 'UI regression fixtures',
    operations: inputs.map((asset) => ({
      op: 'upsert',
      asset: assetSchema.parse(asset),
      expectedRevision: 0,
    })),
  });
}
async function workflowRun(page: Page, prefix: string, canComplete: boolean | undefined = true) {
  await assets(page, [
    {
      id: `${prefix}-role`,
      name: `${prefix} 担当`,
      type: 'role',
      content: 'Read the report and verify results.',
    },
    {
      id: `${prefix}-workflow`,
      name: `${prefix} Workflow`,
      type: 'workflow',
      workflow: {
        developmentCapable: false,
        entryStage: 'review',
        entryRole: `${prefix}-role`,
        completionCriteria: ['納品を確認した'],
        stages: [
          {
            id: 'work',
            name: '実装修正',
            role: `${prefix}-role`,
            canComplete: false,
            requiredAssets: [],
            requiredCapabilities: [],
            completionCriteria: ['修正を検証した'],
            expectedOutput: ['report'],
            transitions: [{ to: 'review', kind: 'advance', requiredArtifacts: ['report'] }],
          },
          {
            id: 'review',
            name: '最終レビュー',
            role: `${prefix}-role`,
            ...(canComplete === undefined ? {} : { canComplete }),
            requiredAssets: [],
            requiredCapabilities: [],
            completionCriteria: ['レビューに合格した'],
            expectedOutput: ['report'],
            transitions: [{ to: 'work', kind: 'return', requiredArtifacts: ['findings'] }],
          },
        ],
      },
    },
  ]);
  return write(page, '/runs', {
    workflowId: `${prefix}-workflow`,
    instruction: `${prefix} 実装と再レビュー`,
  });
}

test('final review supports return and completion with saved evidence, without preview mutations', async ({
  page,
  context,
}) => {
  const run = await workflowRun(page, 'return-evidence');
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && request.url().includes('/api/')) writes.push(request.url());
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/#runs');
  await page.locator('.run-item').filter({ hasText: 'return-evidence 実装と再レビュー' }).click();
  await expect(page.getByRole('button', { name: '実行を完了', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /差し戻す/ })).toBeVisible();
  const before = await state(page);
  await page.getByRole('button', { name: 'AIへの依頼をコピー', exact: true }).click();
  await page.getByRole('button', { name: 'Handoffをプレビュー', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Read the report and verify results.');
  await dialog.getByRole('button', { name: 'Contextをコピー', exact: true }).click();
  await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
  await page.getByRole('button', { name: /^Snapshot 1 ·/ }).click();
  await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
  const after = await state(page);
  expect(after.runs.find((r: any) => r.id === run.id)).toEqual(
    before.runs.find((r: any) => r.id === run.id),
  );
  expect(after.snapshots).toEqual(before.snapshots);
  expect(writes).toEqual([]);

  await page.getByRole('button', { name: /差し戻す/ }).click();
  await dialog.getByLabel('成果物 · findings', { exact: true }).fill('reports/review-r1.md');
  await dialog.getByLabel('記録 / 理由').fill('境界条件の修正が必要');
  await dialog.getByRole('button', { name: '確定する', exact: true }).click();
  await expect(page.getByRole('button', { name: '実行を完了', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /次のStageへ/ }).click();
  await dialog.getByLabel('修正を検証した', { exact: true }).fill('境界条件のテストを追加して合格');
  await dialog.getByLabel('成果物 · report', { exact: true }).fill('reports/fixed-r2.md');
  await dialog.getByRole('button', { name: '確定する', exact: true }).click();
  await page.getByRole('button', { name: '実行を完了', exact: true }).click();
  await expect(dialog.getByLabel('レビューに合格した', { exact: true })).toHaveValue('');
  await dialog
    .getByLabel('レビューに合格した', { exact: true })
    .fill('再レビューで修正と全テストの成功を確認');
  await dialog
    .getByLabel('納品を確認した', { exact: true })
    .fill('reports/fixed-r2.md の内容を確認');
  await dialog.getByRole('button', { name: '確定する', exact: true }).click();
  const evidence = page.getByRole('region', { name: '保存された完了根拠' });
  await expect(evidence).toContainText('再レビューで修正と全テストの成功を確認');
  await expect(evidence).toContainText('最終レビュー');
  await expect(evidence).toContainText('local-user');
  await expect(evidence).toContainText(
    'AACLがテストや成果物を自動検証したことを示すものではありません',
  );
  await expect(evidence).toContainText('試行: 未記録');
  await evidence.getByText('この判断で記録した成果物', { exact: true }).last().click();
  await expect(evidence.getByLabel('判断時の成果物').last()).toContainText('reports/fixed-r2.md');
  await page.reload();
  await page.locator('.run-item').filter({ hasText: 'return-evidence 実装と再レビュー' }).click();
  await expect(evidence).toContainText('再レビューで修正と全テストの成功を確認');
  await evidence.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/run-evidence.png', fullPage: true });
});

test('run filters distinguish Skill, project, workflow and runtime status and clear empty results', async ({
  page,
}) => {
  const data = await state(page);
  const template = data.runs[0] ?? {
    id: 'filter-template',
    title: '',
    instruction: '',
    mode: 'advisory',
    status: 'active',
    version: 1,
    workflow: null,
    stage: null,
    context: {},
    createdAt: '2026-09-01T09:00:00Z',
    updatedAt: '2026-09-01T09:00:00Z',
    events: [],
    artifacts: {},
    criteria: {},
    snapshotIds: [],
    requirements: { completionCriteria: [], expectedOutput: [] },
  };
  const skill = {
    ...assetSchema.parse({ id: 'filter-skill', name: 'API確認Skill', type: 'skill' }),
    revision: 2,
    updatedAt: '2026-09-01T09:00:00Z',
  };
  const statuses = [
    'prepared',
    'delivery-pending',
    'running',
    'result-received',
    'failed',
    'waiting-user',
  ];
  const runs = statuses.map((status, i) => ({
    ...template,
    id: `filter-${i}`,
    title: `探索対象 ${i}`,
    instruction: `unique-${i}`,
    skillId: skill.id,
    skill,
    workflow: null,
    mode: 'advisory',
    stage: null,
    status: i === 3 ? 'completed' : 'active',
    executionStatus: status,
    context: { project: i % 2 ? 'beta' : 'alpha' },
    events: [],
    criteria: {},
    artifacts: {},
    attempts: [],
    snapshotIds: [],
  }));
  const filterWorkflow = {
    ...assetSchema.parse({
      id: 'filter-workflow',
      name: '検索対象Workflow',
      type: 'workflow',
      workflow: {
        developmentCapable: false,
        entryStage: 'check',
        entryRole: 'filter-role',
        stages: [{ id: 'check', name: '確認', role: 'filter-role' }],
      },
    }),
    revision: 1,
    updatedAt: '2026-09-01T09:00:00Z',
  };
  const workflowRuns = [
    {
      ...template,
      id: 'filter-workflow-run',
      title: 'Workflowを検索',
      workflow: filterWorkflow,
      skillId: undefined,
      skill: undefined,
      context: {},
      stage: 'check',
      executionStatus: 'prepared',
    },
  ];
  await page.route('**/api/state', (route) =>
    route.fulfill({
      json: {
        ...data,
        runs: [...runs, ...workflowRuns],
        assets: [...data.assets, skill],
        projects: [
          { id: 'alpha', name: 'Alpha Project', root: '/alpha' },
          { id: 'beta', name: 'Beta Project', root: '/beta' },
        ],
      },
    }),
  );
  await page.goto('/#runs');
  await expect(page.locator('.run-item')).toHaveCount(7);
  await page.getByLabel('Workflowで絞り込み').selectOption('filter-workflow');
  await expect(page.locator('.run-item')).toHaveCount(1);
  await expect(page.locator('.run-item')).toContainText('検索対象Workflow');
  await page.getByRole('button', { name: '絞り込みをクリア', exact: true }).click();
  await expect(page.locator('.run-item').first()).toContainText('API確認Skill');
  await page.getByLabel('Skillで絞り込み').selectOption('filter-skill');
  await page.getByLabel('Projectで絞り込み').selectOption('alpha');
  await expect(page.locator('.run-item')).toHaveCount(3);
  await page.getByLabel('状態で絞り込み').selectOption('failed');
  await expect(page.locator('.run-item')).toHaveCount(1);
  await expect(page.locator('.run-item')).toContainText('実行失敗');
  await page.getByLabel('実行を検索', { exact: true }).fill('missing');
  await expect(page.getByText('条件に一致する実行はありません', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '絞り込みをクリア', exact: true }).click();
  await expect(page.locator('.run-item')).toHaveCount(7);
  await page.getByLabel('状態で絞り込み').selectOption('waiting-user');
  await expect(page.locator('.run-item')).toHaveCount(1);
  await expect(page.locator('.run-detail')).toContainText('人間の判断待ち');
});

test('asset relations preserve imported files and extracted provenance while editing', async ({
  page,
  context,
}) => {
  const relation = {
    target: 'relations-checklist',
    kind: 'conditional' as const,
    condition: '公開APIを変更するとき',
    origin: 'extracted' as const,
    source: { path: 'SKILL.md', line: 12, text: '公開APIを変更するときはchecklistを使う。' },
    reason: '公開APIの確認手順',
  };
  await assets(page, [
    {
      id: 'relations-checklist',
      name: '関係テストのチェックリスト',
      type: 'skill',
      activation: 'on-demand',
    },
    {
      id: 'relations-role',
      name: '関係テストの担当',
      type: 'role',
      relations: [{ ...relation, origin: 'manual' }],
    },
    {
      id: 'relations-import',
      name: '取り込んだ未分類資産',
      type: 'other',
      content: 'Original text',
      files: { 'references/check.md': 'Supplemental checklist' },
      sources: [
        {
          host: 'wsl:Ubuntu',
          path: '/home/owner/.codex/skills/example',
          hash: 'saved-source-hash',
        },
      ],
      relations: [relation],
    },
  ]);
  // Supply saved extraction metadata separately from a content edit, as onboarding does.
  const imported = (await state(page)).assets.find((asset: any) => asset.id === 'relations-import');
  await write(page, '/assets/change', {
    summary: '保存した抽出結果',
    operations: [
      {
        op: 'upsert',
        asset: { ...inputOf(imported), relations: [relation] },
        expectedRevision: imported.revision,
      },
    ],
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/#assets');
  await page.getByRole('button', { name: '取り込んだ未分類資産の詳細', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Scope / Relations', exact: true }).click();
  await expect(dialog).toContainText('条件付き利用');
  await expect(dialog).toContainText('SKILL.md:12');
  await dialog.getByRole('button', { name: '編集する', exact: true }).click();
  await expect(dialog.getByLabel('ID', { exact: true })).toBeDisabled();
  await dialog.getByLabel('種別', { exact: true }).selectOption('skill');
  await expect(dialog.getByLabel('担当Role', { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('model', { exact: true })).toHaveCount(0);
  await dialog.getByText('references/check.md', { exact: false }).first().click();
  const before = await state(page);
  await dialog.getByRole('button', { name: 'references/check.mdをコピー', exact: true }).click();
  await expect(dialog).toBeVisible();
  expect((await state(page)).assets).toEqual(before.assets);
  await dialog.getByLabel('説明', { exact: true }).fill('Updated classification metadata');
  await dialog.getByLabel('関係 1の理由', { exact: true }).fill('公開APIの互換性確認を再利用');
  await dialog.getByRole('button', { name: 'Assetを保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const saved = (await state(page)).assets.find((a: any) => a.id === 'relations-import');
  expect(saved.type).toBe('skill');
  expect(saved.files).toEqual({ 'references/check.md': 'Supplemental checklist' });
  expect(saved.sources).toEqual([
    { host: 'wsl:Ubuntu', path: '/home/owner/.codex/skills/example', hash: 'saved-source-hash' },
  ]);
  expect(saved.relations).toEqual([{ ...relation, reason: '公開APIの互換性確認を再利用' }]);
  await page.getByRole('button', { name: '関係表示', exact: true }).click();
  await page.getByLabel('関係を確認するWorkflow・Role・Model').selectOption('asset:relations-role');
  await expect(page.getByRole('region', { name: '資産の関係図' })).toContainText(
    '関係テストのチェックリスト',
  );
  await page.screenshot({ path: 'test-results/asset-relations.png', fullPage: true });
  await page
    .getByRole('region', { name: '資産の関係図' })
    .getByRole('button', { name: /関係テストのチェックリスト/ })
    .click();
  await dialog.getByRole('button', { name: 'Scope / Relations', exact: true }).click();
  await expect(dialog).toContainText('関係テストの担当');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test('Workflow editor permits completion together with a return edge and preserves explicit false', async ({
  page,
}) => {
  await workflowRun(page, 'completion-editor');
  await page.goto('/#workflows');
  await page
    .locator('.workflow-card-main')
    .filter({ hasText: 'completion-editor Workflow' })
    .click();
  await page.getByRole('button', { name: '定義を編集', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Stage 2: 最終レビュー', exact: true }).click();
  await expect(dialog.getByLabel('このStageでの実行完了', { exact: true })).toHaveValue('true');
  await expect(dialog.getByLabel('遷移 1の種類', { exact: true })).toHaveValue('return');
  await dialog.getByRole('button', { name: 'Stage 1: 実装修正', exact: true }).click();
  await expect(dialog.getByLabel('このStageでの実行完了', { exact: true })).toHaveValue('false');
  await dialog.getByText('説明・本文', { exact: true }).click();
  await dialog.getByLabel('説明', { exact: true }).fill('Completion and return stay independent');
  await dialog.getByRole('button', { name: 'Assetを保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const saved = (await state(page)).assets.find(
    (asset: any) => asset.id === 'completion-editor-workflow',
  );
  expect(saved.workflow.stages[0].canComplete).toBe(false);
  expect(saved.workflow.stages[1].canComplete).toBe(true);
  expect(saved.workflow.stages[1].transitions[0].kind).toBe('return');
});

test('runtime evidence identifies the attempt and Journal observation; Workflow links and comparison retain provenance', async ({
  page,
}) => {
  const initial = await workflowRun(page, 'attempt-evidence');
  const configState = await state(page);
  const configResponse = await page.request.put('/api/config', {
    headers: { 'X-AACL-Token': configState.humanToken },
    data: {
      ...configState.config,
      models: [
        ...configState.config.models,
        { id: 'ui-attempt-model', name: 'UI Attempt Model', provider: 'openai' },
      ],
    },
  });
  expect(configResponse.ok(), await configResponse.text()).toBe(true);
  const handoff = await write(page, `/runs/${initial.id}/handoff`, {
    context: { model: 'ui-attempt-model', runtime: 'codex' },
    delivery: 'runtime-pull',
  });
  const started = await write(page, `/runs/${initial.id}/runtime-event`, {
    expectedVersion: handoff.version,
    event: 'started',
    attemptId: 'attempt-ui-1',
    actualModel: 'ui-attempt-model',
    actualRuntime: 'codex',
    note: 'Started actual fixture invocation',
  });
  const attemptSnapshotId = started.attempts.find((a: any) => a.id === 'attempt-ui-1').snapshotId;
  expect(attemptSnapshotId).not.toBe(handoff.snapshotId);
  await write(page, `/runs/${initial.id}/runtime-event`, {
    expectedVersion: started.version,
    event: 'result',
    attemptId: 'attempt-ui-1',
    artifacts: { report: 'reports/verified.md' },
    note: 'Runtime reported verified output',
  });
  await page.goto('/#runs');
  const detail = page.locator('.run-detail');
  await expect(detail).toContainText('結果を受信');
  await expect(page.getByRole('region', { name: 'AIの試行' })).toContainText('attempt-ui-1');
  await page.getByRole('button', { name: '実行を完了', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('レビューに合格した', { exact: true }).fill('Runtimeの検証記録を確認');
  await dialog.getByLabel('納品を確認した', { exact: true }).fill('成果物の改訂と結果を確認');
  await dialog.getByRole('button', { name: '確定する', exact: true }).click();
  const evidence = page.getByRole('region', { name: '保存された完了根拠' });
  await expect(evidence).toContainText('attempt-ui-1');
  await expect(evidence).toContainText('local-user');
  await expect(evidence).toContainText(attemptSnapshotId);
  await page.getByRole('button', { name: 'Journalを記録', exact: true }).click();
  await dialog.getByLabel('観測対象の試行', { exact: true }).selectOption('attempt-ui-1');
  await dialog.getByLabel('観測した時刻（任意）', { exact: true }).fill('2026-01-02T03:04');
  await dialog.getByLabel('観測したこと', { exact: true }).fill('試行に対応したレビューの観測');
  await dialog.getByRole('button', { name: 'Journalを保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const journal = (await state(page)).journals.find(
    (j: any) => j.observation === '試行に対応したレビューの観測',
  );
  expect(journal.attemptId).toBe('attempt-ui-1');
  expect(journal.snapshotId).toBe(attemptSnapshotId);
  const review = await write(page, '/reviews', {
    journalIds: [journal.id],
    reason: '試行の改善検討',
  });
  await page.goto('/#workflows');
  await page.reload();
  await page
    .locator('.workflow-card-main')
    .filter({ hasText: 'attempt-evidence Workflow' })
    .click();
  const activity = page.getByRole('region', { name: 'Workflowの実行と改善' });
  await expect(activity).toContainText('試行に対応したレビューの観測');
  await activity.getByRole('button', { name: /試行の改善検討/ }).click();
  await expect(dialog).toContainText(review.id.slice(-12));
  await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
  await page.getByRole('button', { name: 'Diagnostics', exact: true }).click();
  await page
    .getByLabel('比較するWorkflow', { exact: true })
    .selectOption('attempt-evidence-workflow');
  const comparison = page.getByRole('region', { name: 'Workflowの比較条件と実試行' });
  await expect(comparison).toContainText('対象: 1件の実行');
  await expect(comparison).toContainText('UI Attempt Model');
  await expect(
    comparison.getByRole('columnheader', { name: 'AIの試行', exact: true }),
  ).toBeVisible();
  await expect(comparison).toContainText('設定版:');
  await comparison.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/workflow-comparison.png', fullPage: true });
});

test('restarting with a newer Workflow preserves the old run and requires fresh evidence', async ({
  page,
}) => {
  const original = await workflowRun(page, 'restart-ui');
  await write(page, `/runs/${original.id}/transition`, {
    expectedVersion: original.version,
    kind: 'complete',
    actor: 'human-ui',
    criteria: { レビューに合格した: '旧版のレビュー結果', 納品を確認した: '旧版の納品確認' },
    artifacts: { report: 'reports/old-revision.md' },
  });
  const beforeRestart = await state(page);
  const workflow = beforeRestart.assets.find((a: any) => a.id === 'restart-ui-workflow');
  await write(page, '/assets/change', {
    summary: '完了条件を強化',
    operations: [
      {
        op: 'upsert',
        expectedRevision: workflow.revision,
        asset: {
          ...inputOf(workflow),
          workflow: { ...workflow.workflow, completionCriteria: ['追加検証を完了した'] },
        },
      },
    ],
  });
  await page.goto('/#runs');
  await page.getByRole('button', { name: '新版で再開する内容を確認', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('追加検証を完了した');
  await expect(dialog.getByRole('checkbox')).not.toBeChecked();
  await dialog.getByRole('checkbox').check();
  await dialog.getByLabel('新版で再開する理由', { exact: true }).fill('追加の検証条件を適用する');
  await dialog.getByRole('button', { name: '新しい実行を作成して再開', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.run-detail')).toContainText('REVISION 2');
  const current = await state(page);
  const restarted = current.runs.find((r: any) => r.restartedFrom?.runId === original.id);
  expect(restarted.criteria).toEqual({});
  expect(restarted.artifacts).toEqual({ report: 'reports/old-revision.md' });
  expect(current.runs.find((r: any) => r.id === original.id)).toEqual(
    beforeRestart.runs.find((r: any) => r.id === original.id),
  );
  await page.getByRole('button', { name: '実行を完了', exact: true }).click();
  await expect(dialog.getByLabel('レビューに合格した', { exact: true })).toHaveValue('');
  await expect(dialog.getByLabel('追加検証を完了した', { exact: true })).toHaveValue('');
});

test('Model relations edit the target scope and preserve other conditions and files', async ({
  page,
}) => {
  await assets(page, [
    {
      id: 'model-relation-skill',
      name: 'モデル専用の確認Skill',
      type: 'skill',
      scope: { runtime: ['codex'] },
      files: { 'checklist.md': 'Keep this file' },
    },
  ]);
  const initial = await state(page);
  const configured = await page.request.put('/api/config', {
    headers: { 'X-AACL-Token': initial.humanToken },
    data: {
      ...initial.config,
      models: [
        ...initial.config.models,
        { id: 'relation-model', name: 'Relation Model', provider: 'openai' },
      ],
    },
  });
  expect(configured.ok(), await configured.text()).toBe(true);
  await page.goto('/#assets');
  await page.getByRole('button', { name: '関係表示', exact: true }).click();
  await page.getByLabel('関係を確認するWorkflow・Role・Model').selectOption('model:relation-model');
  await page
    .getByLabel('Modelに紐づける資産', { exact: true })
    .selectOption('model-relation-skill');
  await page.getByLabel('Modelとの紐づけの理由', { exact: true }).fill('このモデル用の補助手順');
  await page.getByRole('button', { name: 'Modelとの紐づけを保存', exact: true }).click();
  await expect(page.getByLabel('Modelに紐づける資産', { exact: true })).toHaveValue('');
  const linked = (await state(page)).assets.find((a: any) => a.id === 'model-relation-skill');
  expect(linked.scope).toEqual({ model: ['relation-model'], runtime: ['codex'] });
  expect(linked.files).toEqual({ 'checklist.md': 'Keep this file' });
  await page.getByRole('button', { name: 'このModelとの紐づけを編集', exact: true }).click();
  await expect(page.getByText(/最後のmodel条件を解除すると/)).toBeVisible();
  await page.getByLabel('Modelとの紐づけの理由', { exact: true }).fill('Codexの全モデルに適用する');
  await page.getByRole('button', { name: 'Modelとの紐づけを保存', exact: true }).click();
  await expect(page.getByLabel('Modelに紐づける資産', { exact: true })).toHaveValue('');
  const unlinked = (await state(page)).assets.find((a: any) => a.id === 'model-relation-skill');
  expect(unlinked.scope).toEqual({ runtime: ['codex'] });
  expect(unlinked.files).toEqual(linked.files);
});

test('setting history shows recorded values and restores with the inspected version', async ({
  page,
}) => {
  const initial = await state(page);
  const config = {
    ...initial.config,
    models: [
      ...initial.config.models,
      { id: 'history-ui-model', name: '設定履歴の追加モデル', provider: 'openai' },
    ],
  };
  const response = await page.request.put('/api/config', {
    headers: { 'X-AACL-Token': initial.humanToken },
    data: config,
  });
  expect(response.ok(), await response.text()).toBe(true);
  const historyResponse = await page.request.get('/api/settings/history?kind=config');
  const history = await historyResponse.json();
  const entry = history.items[0];
  const inspected = await (await page.request.get('/api/config')).json();
  await page.goto('/#settings');
  const panel = page.getByRole('region', { name: '設定の変更履歴', exact: true });
  await panel.getByLabel('設定履歴の種類', { exact: true }).selectOption('config');
  const record = panel.locator('article').filter({ hasText: entry.id });
  await expect(record).toContainText(entry.reason);
  await expect(record).toContainText(entry.actor);
  await record.getByText('変更前と変更後を比較', { exact: true }).click();
  await expect(record).toContainText('設定履歴の追加モデル');
  await record.getByRole('button', { name: '変更前に戻す内容を確認', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(`現在の設定版は${inspected.settingsVersion}`);
  await expect(dialog).toContainText('復元する値');
  await page.screenshot({ path: 'test-results/settings-restoration.png', fullPage: true });
  await dialog.getByLabel('設定を復元する理由', { exact: true }).fill('追加モデルの設定を元に戻す');
  const restoreRequest = page.waitForRequest(
    (request) => request.url().endsWith('/api/settings/restore') && request.method() === 'POST',
  );
  await dialog.getByRole('button', { name: '変更前の設定を復元', exact: true }).click();
  expect((await restoreRequest).postDataJSON()).toMatchObject({
    id: entry.id,
    side: 'before',
    expectedVersion: inspected.settingsVersion,
  });
  await expect(dialog).toHaveCount(0);
  expect((await state(page)).config).toEqual(initial.config);
  const restoredHistory = await (
    await page.request.get('/api/settings/history?kind=config')
  ).json();
  expect(restoredHistory.items[0].restoreOf).toBe(entry.id);
  await expect(panel).toContainText('追加モデルの設定を元に戻す');
});
