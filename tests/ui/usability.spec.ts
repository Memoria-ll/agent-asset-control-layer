import { test, expect, type Page } from '@playwright/test';

async function write(page: Page, route: string, data: unknown) {
  const state = await (await page.request.get('/api/state')).json();
  const response = await page.request.post(`/api${route}`, {
    data,
    headers: { 'X-AACL-Token': state.humanToken },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test('prepared runs explain the next action and do not increase the running count', async ({
  page,
}) => {
  await write(page, '/starter', {});
  const before = await (await page.request.get('/api/state')).json();
  const running = before.runs.filter(
    (r: any) => r.status === 'active' && r.executionStatus === 'running',
  ).length;
  const prepared = before.runs.filter(
    (r: any) =>
      r.status === 'active' &&
      (r.executionStatus === 'prepared' || (!r.executionStatus && !r.runtimeHandoffAt)),
  ).length;
  await page.goto('/#workflows');
  await page.getByRole('button', { name: 'Issue developmentを起動', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('今回の指示').fill('Usability prepared run');
  await dialog.getByRole('button', { name: '実行を開始', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.locator('.run-detail').getByText('準備済み／AIへ依頼待ち', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: '次の操作：AIへ依頼する' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'AIへの依頼をコピー' })).toBeVisible();
  await expect(
    page.locator('.run-item').filter({ hasText: 'Usability prepared run' }),
  ).not.toContainText('実行中');
  await page.getByRole('button', { name: 'Workflows', exact: true }).click();
  const overview = page.locator('.workspace-overview');
  await expect(
    overview
      .locator(':scope > div')
      .filter({ has: page.getByText('実行中', { exact: true }) })
      .locator('strong'),
  ).toHaveText(String(running));
  await expect(
    overview
      .locator(':scope > div')
      .filter({ has: page.getByText('AIへ依頼待ち', { exact: true }) })
      .locator('strong'),
  ).toHaveText(String(prepared + 1));
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(overview.getByText('AIへ依頼待ち', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/usability-prepared-mobile.png', fullPage: true });
});

test('standalone guidance copies the selected workflow and a valid export request', async ({
  page,
  context,
}) => {
  await write(page, '/starter', {});
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/#context');
  const exportPanel = page.getByRole('region', { name: 'Core不要の単独出力' });
  await expect(exportPanel).toContainText('出力対象を選択してください');
  await page.getByLabel('Workflow', { exact: true }).selectOption('issue-development');
  await exportPanel.getByLabel('単独出力の形式').selectOption('generic');
  await exportPanel.getByRole('button', { name: '単独出力の依頼をコピー' }).click();
  const request = await page.evaluate(() => navigator.clipboard.readText());
  const args = JSON.parse(request.slice(request.indexOf('{'), request.lastIndexOf('}') + 1));
  expect(args.assetIds).toEqual(['issue-development']);
  expect(args.mode).toBe('standalone');
  expect(args.runtime).toBe('generic');
  const bundle = await write(page, '/export-bundle', args);
  expect(bundle.ready).toBe(true);
  expect(bundle.outputSpecifications.requiresCore).toBe(false);
  expect(bundle.files.length).toBeGreaterThan(4);
  await expect(page.getByText('Coreに接続して使うファイルを生成', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/usability-export-guidance.png', fullPage: true });
});

test('onboarding history titles stay concise while original recovery details remain available', async ({
  page,
}) => {
  const summary = `onboarding:usability-history:organize:${'a'.repeat(64)}\nUser request: Preserve this original request\nOrganization reason: Preserve the original rationale`;
  const change = await write(page, '/assets/change', {
    summary,
    operations: [
      {
        op: 'upsert',
        expectedRevision: 0,
        asset: {
          id: 'usability-history-note',
          name: 'History fixture',
          type: 'knowledge',
          content: 'Example',
        },
      },
    ],
  });
  await page.goto('/#history');
  const row = page.locator('.history-row').filter({ hasText: change.id });
  await expect(row).toContainText('既存指示を分類（変更した資産1件）');
  await expect(row).not.toContainText('onboarding:');
  await expect(row).not.toContainText('Preserve this original request');
  await row.click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByRole('heading', { name: '既存指示を分類（変更した資産1件）' }),
  ).toBeVisible();
  await dialog.getByText('導入ID・依頼原文・変更理由', { exact: true }).click();
  await expect(dialog.locator('pre').filter({ hasText: 'onboarding:' })).toHaveText(summary);
  await page.screenshot({ path: 'test-results/usability-history.png', fullPage: true });
});
