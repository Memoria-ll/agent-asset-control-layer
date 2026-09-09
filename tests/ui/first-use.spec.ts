import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function write(page: Page, route: string, data: unknown) {
  const state = await (await page.request.get('/api/state')).json();
  const response = await page.request.post(`/api${route}`, {
    data,
    headers: { 'X-AACL-Token': state.humanToken },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test('project Workflow preserves draft while adding a Role, previews, starts and exposes completed context', async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aacl-ui-project-'));
  const project = await write(page, '/projects', { name: '試用プロジェクト', root });
  await page.goto('/#workflows');
  await page.getByRole('button', { name: 'Workflowを作成', exact: true }).click();
  const draft = page.getByRole('dialog').first();
  await draft.getByLabel('名前', { exact: true }).fill('試用Workflow');
  await draft.getByLabel('ID', { exact: true }).fill('first-use-workflow');
  await draft.getByLabel('保存先', { exact: true }).selectOption(project.id);
  await draft.getByRole('button', { name: 'Roleを追加', exact: true }).click();
  const role = page.getByRole('dialog').last();
  await role.getByLabel('名前', { exact: true }).fill('試用担当');
  await role.getByLabel('ID', { exact: true }).fill('first-use-role');
  await role.getByLabel('本文（Markdown）').fill('プロジェクトの成果物と検証結果を確認する。');
  await role.getByRole('button', { name: 'Assetを保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(draft.getByLabel('名前', { exact: true })).toHaveValue('試用Workflow');
  await expect(draft.getByLabel('保存先', { exact: true })).toHaveValue(project.id);
  await draft.getByLabel('担当Role').selectOption('first-use-role');
  await draft.getByRole('button', { name: 'Stageの成果物を追加', exact: true }).click();
  await draft.getByLabel('Stageの成果物 1', { exact: true }).fill('report');
  await draft.getByRole('button', { name: 'Assetを保存', exact: true }).click();
  await expect(draft).not.toBeVisible();
  await page.locator('.workflow-card-main').filter({ hasText: '試用Workflow' }).click();
  await page.getByRole('button', { name: 'Contextを確認', exact: true }).click();
  await expect(page.getByLabel('Project', { exact: true })).toHaveValue(project.id);
  await expect(page.getByText(/Required Assetが解決されません/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Codex', exact: true }).click();
  await expect(
    page.getByRole('dialog').getByText('配置して使う手順', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText(root);
  await page.getByRole('dialog').getByRole('button', { name: '閉じる', exact: true }).click();
  await page.getByRole('button', { name: 'Workflows', exact: true }).click();
  await page.getByRole('button', { name: '試用Workflowを起動', exact: true }).click();
  await expect(draft.getByLabel('Project', { exact: true })).toHaveValue(project.id);
  await draft.getByLabel('今回の指示').fill('成果物と過去のContextを確認する');
  await draft.getByRole('button', { name: '実行を開始', exact: true }).click();
  await expect(page.locator('.run-detail').getByText('準備済み', { exact: true })).toBeVisible();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'AIへの依頼をコピー', exact: true }).click();
  const request = await page.evaluate(() => navigator.clipboard.readText());
  expect(request).toContain(root);
  expect(request).toContain(project.id);
  const beforePreview = await (await page.request.get('/api/state')).json();
  await page.getByRole('button', { name: 'Handoffをプレビュー', exact: true }).click();
  await expect(draft).toContainText(root);
  await draft.getByRole('button', { name: '閉じる', exact: true }).click();
  const afterPreview = await (await page.request.get('/api/state')).json();
  expect(afterPreview.runs).toEqual(beforePreview.runs);
  expect(afterPreview.snapshots).toEqual(beforePreview.snapshots);
  await page.getByRole('button', { name: '実行を完了', exact: true }).click();
  await draft.getByLabel('検証が完了している', { exact: true }).fill('テストを確認');
  await draft.getByLabel('成果物が確認されている', { exact: true }).fill('内容を確認');
  await draft.getByLabel('成果物 · report', { exact: true }).fill('reports/result.md');
  await draft.getByRole('button', { name: '確定する', exact: true }).click();
  await expect(page.getByRole('region', { name: '保存された完了根拠' })).toContainText(
    'テストを確認',
  );
  await expect(page.getByRole('region', { name: '保存された完了根拠' })).toContainText(
    '内容を確認',
  );
  await page.getByRole('button', { name: /^Snapshot 1 ·/ }).click();
  await expect(draft.getByRole('heading', { name: '渡したContext', exact: true })).toBeVisible();
  await expect(draft).toContainText('成果物と過去のContextを確認する');
  await expect(draft).toContainText('プロジェクトの成果物と検証結果を確認する。');
  await expect(draft).toContainText(root);
  await page.screenshot({ path: 'test-results/saved-context.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('Markdown name and project overlay selections survive save and reopen', async ({ page }) => {
  await write(page, '/starter', {});
  await page.goto('/#assets');
  await page.getByRole('button', { name: 'アセットインポート', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('ID', { exact: true }).fill('named-import-rule');
  await dialog.getByLabel('名前', { exact: true }).fill('画面で指定した名前');
  await dialog.getByLabel('種別', { exact: true }).selectOption('rule');
  await dialog
    .getByLabel('本文 / SKILL.md')
    .fill('---\nname: source-rule\ndescription: Source description\n---\nImported rule.');
  await dialog.getByRole('button', { name: '取り込む', exact: true }).click();
  await expect(page.getByText('画面で指定した名前', { exact: true })).toBeVisible();
  const state = await (await page.request.get('/api/state')).json();
  const project =
    state.projects.find((p: any) => p.name === '試用プロジェクト') ??
    (await write(page, '/projects', {
      name: '試用プロジェクト',
      root: fs.mkdtempSync(path.join(os.tmpdir(), 'aacl-ui-overlay-')),
    }));
  expect(state.assets.find((a: any) => a.id === 'named-import-rule').name).toBe(
    '画面で指定した名前',
  );
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  const panel = page
    .locator('.panel')
    .filter({ has: page.getByRole('heading', { name: '試用プロジェクト', exact: true }) });
  await panel.getByRole('button', { name: 'Overlayを編集' }).click();
  await dialog
    .locator('.token-choices')
    .first()
    .getByText('候補から選ぶ', { exact: false })
    .click();
  await dialog.getByRole('checkbox', { name: '画面で指定した名前', exact: true }).check();
  await dialog.getByLabel('置き換え元', { exact: true }).selectOption('issue-boundary');
  await dialog.getByLabel('置き換え先', { exact: true }).selectOption('review-evidence');
  await dialog.getByRole('button', { name: '置き換えを追加', exact: true }).click();
  await dialog
    .getByLabel('適用条件を変更するAsset', { exact: true })
    .selectOption('named-import-rule');
  await dialog.getByRole('button', { name: '適用条件を追加', exact: true }).click();
  await dialog.getByLabel('named-import-rule · role', { exact: true }).fill('first-use-role');
  await dialog.getByLabel('named-import-rule · role', { exact: true }).press('Enter');
  await page.screenshot({ path: 'test-results/project-overlay-controls.png', fullPage: true });
  await dialog.getByRole('button', { name: 'Overlayを保存', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const saved = (await (await page.request.get('/api/state')).json()).projects.find(
    (p: any) => p.id === project.id,
  );
  expect(saved.disabled).toEqual(['named-import-rule']);
  expect(saved.overrides).toEqual({ 'issue-boundary': 'review-evidence' });
  expect(saved.bindings).toEqual({ 'named-import-rule': { role: ['first-use-role'] } });
  await panel.getByRole('button', { name: 'Overlayを編集' }).click();
  await expect(dialog.getByLabel('置き換え先 · Issueの変更範囲', { exact: true })).toHaveValue(
    'review-evidence',
  );
  await expect(
    dialog.getByRole('button', { name: 'named-import-ruleを除く', exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});

test('approval shows text and Workflow changes before applying a new proposal', async ({
  page,
}) => {
  await write(page, '/starter', {});
  const run = await write(page, '/runs', { instruction: 'New workflow proposal' });
  const journal = await write(page, '/journals', {
    snapshotId: run.snapshotIds[0],
    kind: 'improvement',
    observation: '新しい確認手順が必要です',
  });
  const review = await write(page, '/reviews', {
    journalIds: [journal.id],
    reason: '確認手順の作成',
  });
  await write(page, `/reviews/${review.id}/proposal`, {
    reason: 'Create a recheck workflow',
    proposedBy: 'test-runtime',
    operations: [
      {
        op: 'upsert',
        expectedRevision: 0,
        asset: {
          id: 'proposed-recheck',
          name: '提案された再確認',
          type: 'workflow',
          content: '今回追加する作業手順です。',
          workflow: {
            developmentCapable: false,
            entryRole: 'reviewer',
            entryStage: 'verify',
            completionCriteria: ['結果を記録した'],
            stages: [
              {
                id: 'verify',
                name: '再確認工程',
                role: 'reviewer',
                expectedOutput: ['report'],
                transitions: [{ to: 'finish', kind: 'advance', requiredArtifacts: ['report'] }],
              },
              { id: 'finish', name: '完了工程', role: 'reviewer' },
            ],
          },
        },
      },
    ],
  });
  await page.goto('/#journals');
  await page.getByText('Create a recheck workflow', { exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByRole('heading', { name: '承認前の変更内容', exact: true }),
  ).toBeVisible();
  await expect(dialog.locator('.diff-line.added')).toContainText('今回追加する作業手順です。');
  await expect(dialog.getByRole('region', { name: '提案のWorkflow構造' })).toContainText(
    '再確認工程',
  );
  await dialog.getByRole('region', { name: '提案のWorkflow構造' }).scrollIntoViewIfNeeded();
  await expect(dialog.getByRole('region', { name: '提案のWorkflow構造' })).toContainText(
    '次へ → 完了工程',
  );
  await page.screenshot({ path: 'test-results/workflow-proposal-preview.png', fullPage: true });
  await dialog.getByRole('button', { name: '承認して反映', exact: true }).click();
  await expect(dialog.getByText('承認済み', { exact: true })).toBeVisible();
});
