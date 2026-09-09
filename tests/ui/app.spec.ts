import { test, expect } from '@playwright/test';

test('UI: starter, scoped asset, preview, workflow, journal, proposal approval and history', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Workflows', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/workflows-empty.png', fullPage: true });
  await page.getByRole('button', { name: 'スターターを追加', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Issue development', exact: true }).first(),
  ).toBeVisible();
  await page.screenshot({ path: 'test-results/workflows.png', fullPage: true });
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await page.getByRole('button', { name: 'Assetを作成' }).click();
  const editor = page.getByRole('dialog');
  await editor.getByLabel('名前', { exact: true }).fill('UIで作成したRule');
  await editor.getByLabel('ID', { exact: true }).fill('ui-rule');
  await editor.getByLabel('本文（Markdown）').fill('実装前に対象Issueを確認してください。');
  await editor.locator('summary').filter({ hasText: '適用条件' }).click();
  await editor.getByLabel('workflow', { exact: true }).fill('issue-development');
  await editor.getByLabel('role', { exact: true }).fill('implementer');
  await editor.getByRole('button', { name: 'Assetを保存' }).click();
  await expect(editor).not.toBeVisible();
  await expect(page.getByText('UIで作成したRule', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Context Preview', exact: true }).click();
  await page.getByLabel('Workflow', { exact: true }).selectOption('issue-development');
  await page.getByLabel('Stage', { exact: true }).selectOption('implementation');
  await expect(page.getByText('UIで作成したRule', { exact: true })).toBeVisible();
  await page.getByText('UIで作成したRule', { exact: true }).click();
  await expect(
    page
      .locator('details')
      .filter({ has: page.getByText('UIで作成したRule', { exact: true }) })
      .getByText(/scope一致: workflow=issue-development AND role=implementer/),
  ).toBeVisible();
  await page.screenshot({ path: 'test-results/context-preview.png', fullPage: true });
  await page.getByLabel('Stage', { exact: true }).selectOption('code-review');
  await page.getByRole('button', { name: /^除外・競合/ }).click();
  await expect(page.getByText('UIで作成したRule', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Workflows', exact: true }).click();
  await page.getByRole('button', { name: 'Issue developmentを起動' }).click();
  await page.getByLabel('今回の指示').fill('#123 ブラウザ操作を検証');
  await page.getByRole('button', { name: '実行を開始', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '#123 ブラウザ操作を検証', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '次のStageへ' }).click();
  await page.getByLabel('受付・計画の結果を確認した').fill('対象Issueと要求範囲を確認した');
  await page.getByLabel('成果物 · brief').fill('docs/brief.md');
  await page.getByRole('button', { name: '確定する' }).click();
  await expect(page.getByRole('heading', { name: '仕様策定', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Journalを記録', exact: true }).click();
  await page.getByLabel('観測したこと').fill('仕様策定で対象の説明が不足していた');
  await page.getByRole('button', { name: 'Journalを保存' }).click();
  await page.getByRole('button', { name: 'Journal & Reviews', exact: true }).click();
  await page.getByRole('checkbox').first().check();
  await page.getByRole('button', { name: /選択した1件をReview/ }).click();
  await page.getByRole('button', { name: 'Reviewを開始', exact: true }).click();
  const review = page.getByRole('dialog');
  await expect(review.getByText('AI Runtimeからの提案を待っています')).toBeVisible();
  await review.getByText('JSON提案を取り込む', { exact: true }).click();
  await review.locator('textarea').fill(
    JSON.stringify({
      reason: '仕様策定で説明不足が観測されたため、specifierに要件確認のRuleを提案する。',
      proposedBy: 'browser-test',
      operations: [
        {
          op: 'upsert',
          expectedRevision: 0,
          asset: {
            id: 'clarify-target',
            type: 'rule',
            name: '対象の明確化',
            content: '仕様策定時に対象の説明を確認する。',
            scope: { role: ['specifier'] },
          },
        },
      ],
    }),
  );
  await review.getByRole('button', { name: '提案を取り込む', exact: true }).click();
  await expect(review.getByRole('button', { name: '承認して反映' })).toBeVisible();
  const before = await (await page.request.get('/api/state')).json();
  expect(before.assets.some((a: any) => a.id === 'clarify-target')).toBe(false);
  await page.screenshot({ path: 'test-results/review-proposal.png', fullPage: true });
  await review.getByRole('button', { name: '承認して反映' }).click();
  await expect(review.getByText('approved', { exact: true })).toBeVisible();
  await review.getByRole('button', { name: '閉じる' }).click();
  await page.getByRole('button', { name: 'Change History', exact: true }).click();
  await expect(page.getByText('journal-review', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /仕様策定で説明不足が観測されたため/ }).click();
  await expect(page.getByRole('dialog').getByText('clarify-target', { exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '閉じる' }).click();
  await page.getByRole('button', { name: 'Diagnostics', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Workflow / revision別の観測' })).toBeVisible();
  await page.screenshot({ path: 'test-results/diagnostics.png', fullPage: true });
  expect(errors).toEqual([]);
});
test('responsive UI and keyboard-accessible dialogs', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Workflows', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
  await page.getByRole('button', { name: '新しい実行', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
});
