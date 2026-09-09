import { test, expect, type Page } from '@playwright/test';
import { assetSchema, inputOf, type AssetInput, type Config } from '../../server/domain.ts';

test.use({ actionTimeout: 10000 });

async function state(page: Page) {
  return (await page.request.get('/api/state')).json();
}
async function write(page: Page, route: string, data: unknown, method = 'POST') {
  const current = await state(page);
  const response = await page.request.fetch(`/api${route}`, {
    method,
    data,
    headers: { 'X-AACL-Token': current.humanToken },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function fixtures(page: Page, prefix: string) {
  const inputs: Partial<AssetInput>[] = [
    {
      id: `${prefix}-reference`,
      name: `${prefix} 参照手順`,
      type: 'skill',
      activation: 'on-demand',
      description: '必要なときに補足する手順',
      content: 'REFERENCE_BODY_MUST_STAY_DEFERRED',
    },
    {
      id: `${prefix}-skill`,
      name: `${prefix} チェック手順`,
      type: 'skill',
      activation: 'on-demand',
      description: '検証項目と報告方法を確認する',
      content: 'PINNED_SKILL_BODY_REVISION_ONE',
      files: { 'references/check.md': 'FILE_BODY_MUST_STAY_DEFERRED' },
      dependencies: [`${prefix}-reference`],
    },
    {
      id: `${prefix}-role`,
      name: `${prefix} 担当`,
      type: 'role',
      content: '報告を確認する担当者です。',
      relations: [
        {
          target: `${prefix}-skill`,
          kind: 'required',
          origin: 'manual',
          reason: '検証手順を候補にする',
        },
      ],
    },
    {
      id: `${prefix}-workflow`,
      name: `${prefix} Workflow`,
      type: 'workflow',
      workflow: {
        developmentCapable: false,
        entryRole: `${prefix}-role`,
        entryStage: 'review',
        completionCriteria: [],
        stages: [
          {
            id: 'review',
            name: '確認',
            role: `${prefix}-role`,
            canComplete: true,
            requiredAssets: [],
            requiredCapabilities: [],
            completionCriteria: [],
            transitions: [],
          },
        ],
      },
    },
  ];
  await write(page, '/assets/change', {
    summary: 'Progressive Skill UI fixtures',
    operations: inputs.map((asset) => ({
      op: 'upsert',
      asset: assetSchema.parse(asset),
      expectedRevision: 0,
    })),
  });
}

test('zero-model binding starts a Workflow and explicitly retrieves its pinned Skill without delivering', async ({
  page,
  context,
}) => {
  const original = (await state(page)).config as Config;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await fixtures(page, 'progressive-default');
  try {
    await write(page, '/config', { ...original, models: [], bindings: [] }, 'PUT');
    await page.goto('/#settings');
    await expect(page.getByRole('heading', { name: 'モデル未登録でも実行できます' })).toBeVisible();
    await page.getByRole('button', { name: /^Roleへの割り当て/ }).click();
    await page.getByRole('button', { name: '割り当てを追加', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Role', { exact: true }).selectOption('progressive-default-role');
    await dialog.getByLabel('適用するWorkflow').selectOption('progressive-default-workflow');
    await expect(dialog.getByLabel('Model', { exact: true })).toHaveValue('');
    await dialog.getByLabel('Runtime', { exact: true }).selectOption(original.runtimes[0].id);
    await dialog.getByRole('button', { name: '割り当てる', exact: true }).click();
    await page.getByRole('button', { name: '設定を保存', exact: true }).click();
    await expect(page.getByRole('button', { name: '設定を保存', exact: true })).toBeDisabled();
    expect((await state(page)).config.bindings).toEqual([
      {
        role: 'progressive-default-role',
        workflow: 'progressive-default-workflow',
        runtime: original.runtimes[0].id,
      },
    ]);
    await page.getByRole('button', { name: 'Executions', exact: true }).click();
    await page.getByRole('button', { name: '新しい実行', exact: true }).first().click();
    await dialog.getByLabel('Workflow / Skill').selectOption('progressive-default-workflow');
    await dialog.getByLabel('今回の指示').fill('標準モデルで検証する');
    await expect(dialog.getByLabel('Model', { exact: true })).toHaveValue('');
    await dialog.getByRole('button', { name: '実行を開始', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const prepared = (await state(page)).runs.find(
      (r: any) => r.workflow?.id === 'progressive-default-workflow',
    );
    const snapshot = await (
      await page.request.get(`/api/snapshots/${prepared.snapshotIds.at(-1)}`)
    ).json();
    expect(snapshot.modelSelection).toEqual({ policy: 'runtime-default' });
    expect(snapshot.resolution.assets.every((a: any) => a.type !== 'skill')).toBe(true);
    expect(snapshot.resolution.content).not.toContain('PINNED_SKILL_BODY_REVISION_ONE');
    await expect(page.getByText('PINNED_SKILL_BODY_REVISION_ONE', { exact: true })).toHaveCount(0);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const requests: any[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/api/skills/get')) requests.push(request.postDataJSON());
    });
    await page.getByRole('button', { name: 'Handoffをプレビュー', exact: true }).click();
    await expect(dialog).toContainText('指定なし · Runtimeの標準設定');
    const candidate = dialog.getByRole('article', {
      name: 'progressive-default チェック手順',
      exact: true,
    });
    await expect(candidate).toContainText('説明のみ・本文未取得');
    await dialog.getByRole('button', { name: 'Contextをコピー', exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).not.toContain(
      'PINNED_SKILL_BODY_REVISION_ONE',
    );
    expect(requests).toEqual([]);
    expect((await state(page)).runs.find((r: any) => r.id === prepared.id)).toEqual(prepared);
    const currentSkill = (await state(page)).assets.find(
      (a: any) => a.id === 'progressive-default-skill',
    );
    await write(page, '/assets/change', {
      summary: 'A newer body must not replace the pinned revision',
      operations: [
        {
          op: 'upsert',
          asset: { ...inputOf(currentSkill), content: 'NEWER_BODY_NOT_FOR_THIS_SNAPSHOT' },
          expectedRevision: currentSkill.revision,
        },
      ],
    });
    await candidate.screenshot({ path: 'test-results/progressive-candidates.png' });
    await candidate.getByRole('button', { name: 'この版の本文を取得', exact: true }).click();
    await expect(candidate.getByLabel('取得したSkill本文')).toContainText(
      'PINNED_SKILL_BODY_REVISION_ONE',
    );
    await expect(candidate).not.toContainText('NEWER_BODY_NOT_FOR_THIS_SNAPSHOT');
    await expect(candidate).not.toContainText('FILE_BODY_MUST_STAY_DEFERRED');
    await expect(candidate).not.toContainText('REFERENCE_BODY_MUST_STAY_DEFERRED');
    await candidate.getByText('補助ファイル・参照先（説明のみ）', { exact: true }).click();
    await expect(candidate.getByText('references/check.md', { exact: true })).toBeVisible();
    await expect(
      candidate.getByText('progressive-default 参照手順', { exact: true }),
    ).toBeVisible();
    expect(requests).toEqual([
      { id: 'progressive-default-skill', revision: 1, snapshotId: snapshot.id, usage: 'inspect' },
    ]);
    await candidate.getByRole('button', { name: 'Skill本文をコピー', exact: true }).click();
    expect(requests).toHaveLength(1);
    const after = (await state(page)).runs.find((r: any) => r.id === prepared.id);
    expect(after.version).toBe(prepared.version);
    expect(after.snapshotIds).toEqual(prepared.snapshotIds);
    expect(after.lastHandoff).toBeUndefined();
    expect(after.skillReads).toEqual([
      expect.objectContaining({
        assetId: 'progressive-default-skill',
        revision: 1,
        snapshotId: snapshot.id,
      }),
    ]);
    expect(after.skillReads[0].usedAt).toBeUndefined();
    expect(await (await page.request.get(`/api/snapshots/${snapshot.id}`)).json()).toEqual(
      snapshot,
    );
    await candidate.screenshot({ path: 'test-results/progressive-retrieval.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    expect(errors).toEqual([]);
  } finally {
    await write(page, '/config', original, 'PUT');
  }
});

test('requested models stay separate from unknown and reported actual models; usage is a separate report', async ({
  page,
}) => {
  const original = (await state(page)).config as Config;
  await fixtures(page, 'progressive-observed');
  const runtime = original.runtimes[0];
  try {
    await write(
      page,
      '/config',
      {
        ...original,
        models: [
          ...original.models,
          { id: 'ui-requested-model', name: 'Requested model', provider: runtime.provider },
        ],
      },
      'PUT',
    );
    const requested = await write(page, '/runs', {
      instruction: '明示モデルの未報告を確認',
      context: { runtime: runtime.id, model: 'ui-requested-model' },
    });
    const handoff = await write(page, `/runs/${requested.id}/handoff`, {
      expectedVersion: requested.version,
    });
    const started = await write(page, `/runs/${requested.id}/runtime-event`, {
      event: 'started',
      attemptId: 'ui-requested-attempt',
      expectedVersion: handoff.version,
      note: 'Model was not reported',
    });
    expect(started.attempts[0].requestedModel).toBe('ui-requested-model');
    expect(started.attempts[0].actualModel).toBeUndefined();
    expect(started.attempts[0].model).toBeUndefined();
    await page.goto('/#runs');
    const attempts = page.getByRole('region', { name: 'AIの試行', exact: true });
    await expect(attempts).toContainText('ui-requested-attempt');
    await expect(attempts.getByText('ui-requested-model', { exact: true })).toBeVisible();
    await expect(attempts.getByText('不明 · Runtimeから未報告', { exact: true })).toBeVisible();
    await attempts.screenshot({ path: 'test-results/model-requested-unknown.png' });
    const defaultRun = await write(page, '/runs', {
      workflowId: 'progressive-observed-workflow',
      instruction: '実モデルをRuntimeから報告する',
      context: { runtime: runtime.id },
    });
    const defaultHandoff = await write(page, `/runs/${defaultRun.id}/handoff`, {
      expectedVersion: defaultRun.version,
    });
    expect(defaultHandoff.launch.modelPolicy).toBe('runtime-default');
    expect(defaultHandoff.launch).not.toHaveProperty('model');
    const observed = await write(page, `/runs/${defaultRun.id}/runtime-event`, {
      event: 'started',
      attemptId: 'ui-observed-attempt',
      expectedVersion: defaultHandoff.version,
      actualModel: 'unregistered-runtime-model',
      actualRuntime: runtime.id,
    });
    const actualSnapshotId = observed.attempts[0].snapshotId;
    expect(actualSnapshotId).not.toBe(defaultHandoff.snapshotId);
    await write(page, '/skills/get', {
      id: 'progressive-observed-skill',
      revision: 1,
      snapshotId: actualSnapshotId,
      attemptId: 'ui-observed-attempt',
      usage: 'use',
      reason: 'Runtime reports using the checklist',
    });
    await page.reload();
    await expect(attempts).toContainText('ui-observed-attempt');
    await expect(attempts).toContainText('指定なし · Runtimeの標準設定');
    await expect(attempts).toContainText('unregistered-runtime-model');
    const candidate = page.getByRole('article', {
      name: 'progressive-observed チェック手順',
      exact: true,
    });
    await expect(candidate).toContainText('使用の報告あり');
    await candidate.locator('summary').filter({ hasText: '取得・使用の記録' }).click();
    await expect(candidate).toContainText('Runtime reports using the checklist');
    await expect(page.getByText('PINNED_SKILL_BODY_REVISION_ONE', { exact: true })).toHaveCount(0);
    await attempts.screenshot({ path: 'test-results/model-actual-reported.png' });
  } finally {
    await write(page, '/config', original, 'PUT');
  }
});

test('unsupported explicit model selection is visible and prevents launching until resolved', async ({
  page,
}) => {
  const original = (await state(page)).config as Config;
  const runtime = original.runtimes[0];
  try {
    await write(
      page,
      '/config',
      {
        ...original,
        runtimes: original.runtimes.map((r) =>
          r.id === runtime.id ? { ...r, supportsModelSelection: false } : r,
        ),
        models: [
          ...original.models,
          {
            id: 'ui-unsupported-model',
            name: 'Unsupported explicit model',
            provider: runtime.provider,
          },
        ],
      },
      'PUT',
    );
    await page.goto('/#runs');
    await page.getByRole('button', { name: '新しい実行', exact: true }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Runtime', { exact: true }).selectOption(runtime.id);
    await dialog.getByLabel('Model', { exact: true }).selectOption('ui-unsupported-model');
    await expect(dialog.getByRole('alert')).toContainText('モデルの明示指定に対応していません');
    await expect(dialog.getByRole('button', { name: '実行を開始', exact: true })).toBeDisabled();
    await dialog.getByLabel('Model', { exact: true }).selectOption('');
    await expect(dialog.getByRole('button', { name: '実行を開始', exact: true })).toBeEnabled();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
  } finally {
    await write(page, '/config', original, 'PUT');
  }
});

test('Workflow editor preserves optional runtime, model and independent model constraints', async ({
  page,
}) => {
  const original = (await state(page)).config as Config;
  const runtime = original.runtimes[0];
  await fixtures(page, 'progressive-stage');
  try {
    await write(
      page,
      '/config',
      {
        ...original,
        models: [
          ...original.models,
          { id: 'ui-stage-model', name: 'Stage model', provider: runtime.provider },
        ],
      },
      'PUT',
    );
    await page.goto('/#workflows');
    await page
      .locator('.workflow-card-main')
      .filter({ hasText: 'progressive-stage Workflow' })
      .click();
    await page.getByRole('button', { name: '定義を編集', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('Runtime・モデルの指定（任意）', { exact: true }).click();
    await expect(dialog.getByLabel('Stageのモデル', { exact: true })).toHaveValue('');
    await dialog.getByLabel('StageのRuntime', { exact: true }).selectOption(runtime.id);
    await dialog.getByLabel('Stageのモデル', { exact: true }).selectOption('ui-stage-model');
    await dialog.getByRole('button', { name: '次のStageを追加', exact: true }).click();
    await dialog.getByText('Runtime・モデルの指定（任意）', { exact: true }).click();
    await dialog
      .getByLabel('このStageとは別の実モデルを使う', { exact: true })
      .selectOption('review');
    await dialog.getByRole('button', { name: 'Assetを保存', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const saved = (await state(page)).assets.find(
      (a: any) => a.id === 'progressive-stage-workflow',
    );
    expect(saved.workflow.stages[0]).toMatchObject({
      model: 'ui-stage-model',
      runtime: runtime.id,
      canComplete: true,
    });
    expect(saved.workflow.stages[1].model).toBeUndefined();
    expect(saved.workflow.stages[1].modelConstraint).toEqual({ differentFromStage: 'review' });
    await page.getByRole('button', { name: '定義を編集', exact: true }).click();
    await dialog.getByText('Runtime・モデルの指定（任意）', { exact: true }).click();
    await dialog.getByLabel('Stageのモデル', { exact: true }).selectOption('');
    await dialog.getByLabel('必須モデル', { exact: true }).selectOption('ui-stage-model');
    await dialog.getByRole('button', { name: 'Assetを保存', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const constrained = (await state(page)).assets.find(
      (a: any) => a.id === 'progressive-stage-workflow',
    ).workflow.stages[0];
    expect(constrained.model).toBeUndefined();
    expect(constrained.modelConstraint).toEqual({ model: 'ui-stage-model' });
  } finally {
    await write(page, '/config', original, 'PUT');
  }
});
