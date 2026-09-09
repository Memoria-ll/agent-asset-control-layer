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
  await expect(review.getByText('承認済み', { exact: true })).toBeVisible();
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

test('model and role forms save bindings, preserve references on rename, and discard drafts', async ({
  page,
}) => {
  await page.goto('/#settings');
  await page.getByRole('button', { name: 'モデルを追加', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('モデルID', { exact: true }).fill('ui-test-model');
  await dialog.getByLabel('表示名（任意）').fill('Test model');
  await dialog.getByLabel('Provider', { exact: true }).selectOption('openai');
  await page.screenshot({ path: 'test-results/model-form.png', fullPage: true });
  await dialog.getByRole('button', { name: '追加する', exact: true }).click();
  await expect(page.getByText('未保存の変更があります')).toBeVisible();
  await page.getByRole('button', { name: /^Roleへの割り当て/ }).click();
  await page.getByRole('button', { name: '割り当てを追加', exact: true }).click();
  await dialog.getByLabel('Role', { exact: true }).selectOption('implementer');
  await dialog.getByLabel('適用するWorkflow').selectOption('issue-development');
  await dialog.getByLabel('Model', { exact: true }).selectOption('ui-test-model');
  await expect(dialog.getByLabel('Runtime', { exact: true })).toHaveValue('codex');
  await expect(dialog.getByLabel('Runtime', { exact: true }).locator('option')).toHaveCount(2);
  await dialog.getByRole('button', { name: '割り当てる', exact: true }).click();
  await page.getByRole('button', { name: '設定を保存', exact: true }).click();
  await expect(page.getByRole('button', { name: '設定を保存', exact: true })).toBeDisabled();
  await page.reload();
  const editor = page.locator('.runtime-editor');
  await expect(editor.getByText('Test model', { exact: true })).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Test modelを削除' })).toBeDisabled();
  await editor.getByRole('button', { name: '編集', exact: true }).click();
  await expect(dialog.getByLabel('Provider', { exact: true })).toBeDisabled();
  await dialog.getByLabel('モデルID', { exact: true }).fill('ui-renamed-model');
  await dialog.getByRole('button', { name: '変更する', exact: true }).click();
  await editor.getByRole('button', { name: '設定を保存', exact: true }).click();
  await expect(editor.getByRole('button', { name: '設定を保存', exact: true })).toBeDisabled();
  const state = await (await page.request.get('/api/state')).json();
  expect(state.config.models).toEqual([
    { id: 'ui-renamed-model', name: 'Test model', provider: 'openai' },
  ]);
  expect(state.config.bindings).toEqual([
    {
      role: 'implementer',
      workflow: 'issue-development',
      model: 'ui-renamed-model',
      runtime: 'codex',
    },
  ]);
  await editor.getByRole('button', { name: '編集', exact: true }).click();
  await dialog.getByLabel('表示名（任意）').fill('Unsaved name');
  await dialog.getByRole('button', { name: '変更する', exact: true }).click();
  await editor.getByRole('button', { name: '変更を戻す', exact: true }).click();
  await expect(editor.getByText('Test model', { exact: true })).toBeVisible();
  await expect(editor.getByText('Unsaved name', { exact: true })).toHaveCount(0);
  await editor.getByRole('button', { name: /^Roleへの割り当て/ }).click();
  await page.screenshot({ path: 'test-results/runtime-bindings.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/runtime-mobile.png', fullPage: true });
});

test('scope picker commits multiple values and candidates; context skills can be toggled and reset', async ({
  page,
}) => {
  await page.goto('/#assets');
  await page.getByRole('button', { name: 'Assetを作成' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('名前', { exact: true }).fill('複数条件のRule');
  await dialog.getByLabel('ID', { exact: true }).fill('multi-scope-rule');
  await dialog.locator('summary').filter({ hasText: '適用条件' }).click();
  const role = dialog.getByLabel('role', { exact: true });
  await role.pressSequentially('implementer,reviewer');
  await role.press('Enter');
  await expect(
    dialog.getByRole('button', { name: 'implementerを除く', exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'reviewerを除く', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'reviewerを除く', exact: true }).click();
  const picker = dialog.locator('.field').filter({ has: page.getByLabel('role', { exact: true }) });
  await picker.locator('summary').click();
  await picker.getByRole('checkbox', { name: 'Specifier', exact: true }).check();
  await dialog.getByLabel('directory', { exact: true }).pressSequentially('src,tests');
  await page.screenshot({ path: 'test-results/scope-picker.png', fullPage: true });
  await dialog.getByRole('button', { name: 'Assetを保存' }).click();
  await expect(dialog).not.toBeVisible();
  const state = await (await page.request.get('/api/state')).json();
  expect(state.assets.find((a: any) => a.id === 'multi-scope-rule').scope).toEqual({
    role: ['implementer', 'specifier'],
    directory: ['src', 'tests'],
  });
  await page.getByRole('button', { name: 'Context Preview', exact: true }).click();
  const skill = page.getByRole('checkbox', { name: 'security review', exact: true });
  const included = page.locator('.resolution-list');
  await expect(included.getByText('security review', { exact: true })).toHaveCount(0);
  await skill.check();
  await expect(included.getByText('security review', { exact: true })).toBeVisible();
  await skill.uncheck();
  await expect(included.getByText('security review', { exact: true })).toHaveCount(0);
  await page.getByLabel('Workflow', { exact: true }).selectOption('issue-development');
  await expect(page.getByLabel('Role', { exact: true })).toHaveValue('orchestrator');
  await expect(page.getByLabel('Task type', { exact: true })).toHaveValue('feature-development');
  await skill.check();
  await page.getByRole('button', { name: '条件をリセット', exact: true }).click();
  await expect(skill).not.toBeChecked();
  await expect(page.getByLabel('Workflow', { exact: true })).toHaveValue('');
});

test('keyboard search and resume open the existing execution without starting another', async ({
  page,
}) => {
  await page.goto('/#workflows');
  await expect(page.getByRole('heading', { name: 'Workflows', exact: true })).toBeVisible();
  await page.keyboard.press('/');
  const search = page.getByPlaceholder('Assetを検索…');
  await expect(search).toBeFocused();
  await search.fill('issue-boundary');
  await expect(page.getByRole('heading', { name: 'Assets', exact: true })).toBeVisible();
  await expect(page.getByText('Issueの変更範囲', { exact: true })).toBeVisible();
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(search).not.toBeFocused();
  await page.keyboard.press('Control+k');
  await expect(search).toBeFocused();
  await search.fill('no-such-asset');
  await page.getByRole('button', { name: '検索をクリア' }).click();
  await expect(search).toHaveValue('');
  await expect(search).toBeFocused();
  await page.getByRole('button', { name: 'Workflows', exact: true }).click();
  const before = await (await page.request.get('/api/state')).json();
  const active = before.runs.find((r: any) => r.status === 'active');
  expect(active).toBeTruthy();
  await page.screenshot({ path: 'test-results/workflows-resume.png', fullPage: true });
  await page.getByRole('button', { name: /続きを開く/ }).click();
  await expect(page.getByRole('heading', { name: active.title, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'AIへの依頼をコピー' })).toBeVisible();
  await page.screenshot({ path: 'test-results/execution.png', fullPage: true });
  const after = await (await page.request.get('/api/state')).json();
  expect(after.runs.length).toBe(before.runs.length);
  expect(after.snapshots.length).toBe(before.snapshots.length);
});

test('visual workflow editor creates, renames, connects, restores and executes stages without JSON', async ({
  page,
}) => {
  await page.goto('/#workflows');
  await page.getByRole('button', { name: 'Workflowを作成', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Workflow定義（JSON）')).toHaveCount(0);
  await dialog.getByLabel('名前', { exact: true }).fill('画面で作成したWorkflow');
  await dialog.getByLabel('ID', { exact: true }).fill('visual-workflow');
  await dialog.getByLabel('Stage名', { exact: true }).fill('準備');
  await dialog.getByLabel('Stage ID', { exact: true }).fill('prepare');
  await dialog.getByLabel('Stage ID', { exact: true }).press('Tab');
  await dialog.getByLabel('担当Role').selectOption('specifier');
  await dialog.getByLabel('Stage完了条件 1', { exact: true }).fill('仕様を確認した');
  await dialog.getByRole('button', { name: '次のStageを追加', exact: true }).click();
  await dialog.getByLabel('Stage名', { exact: true }).fill('確認');
  await dialog.getByLabel('Stage ID', { exact: true }).fill('verify');
  await dialog.getByLabel('Stage ID', { exact: true }).press('Tab');
  await dialog.getByLabel('担当Role').selectOption('reviewer');
  await dialog.getByRole('button', { name: 'Stageを削除', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Stage 2: 確認', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: '削除を取り消す', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Stage 2: 確認', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Stage 1: 準備', exact: true }).click();
  await dialog.getByLabel('遷移 1の必要成果物').fill('specification');
  await dialog.getByLabel('遷移 1の必要成果物').press('Enter');
  await dialog.getByRole('button', { name: '遷移を追加', exact: true }).click();
  await expect(dialog.getByText(/不正な遷移/)).toBeVisible();
  await dialog.getByLabel('遷移 2の種類').selectOption('retry');
  await dialog.getByLabel('遷移 2の接続先').selectOption('prepare');
  await dialog.getByLabel('Stage ID', { exact: true }).fill('begin');
  await dialog.getByLabel('Stage ID', { exact: true }).press('Tab');
  await expect(dialog.getByLabel('開始Stage')).toHaveValue('begin');
  await expect(dialog.getByLabel('遷移 2の接続先')).toHaveValue('begin');
  await expect(dialog.getByText('接続を確認済み')).toBeVisible();
  await dialog.getByLabel('Workflow完了条件 1', { exact: true }).fill('レビュー結果を確認した');
  await dialog.locator('.workflow-canvas').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: 'test-results/workflow-visual-editor.png', fullPage: true });
  await dialog.getByRole('button', { name: 'Assetを保存' }).click();
  await expect(dialog).not.toBeVisible();
  const state = await (await page.request.get('/api/state')).json();
  const workflow = state.assets.find((a: any) => a.id === 'visual-workflow').workflow;
  expect(workflow.entryStage).toBe('begin');
  expect(workflow.entryRole).toBe('specifier');
  expect(workflow.stages[0].transitions).toEqual([
    { to: 'verify', kind: 'advance', requiredArtifacts: ['specification'] },
    { to: 'begin', kind: 'retry', requiredArtifacts: [] },
  ]);
  expect(workflow.stages[1].role).toBe('reviewer');
  await page.getByRole('button', { name: '画面で作成したWorkflowを起動' }).click();
  await page.getByLabel('今回の指示').fill('ビジュアル編集の実行検証');
  await page.getByRole('button', { name: '実行を開始', exact: true }).click();
  await expect(page.getByRole('heading', { name: '準備', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '次のStageへ' }).click();
  await page.getByLabel('仕様を確認した', { exact: true }).fill('仕様を承認済み');
  await page.getByLabel('成果物 · specification').fill('docs/spec.md');
  await page.getByRole('button', { name: '確定する', exact: true }).click();
  await expect(page.getByRole('heading', { name: '確認', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Workflows', exact: true }).click();
  await page
    .getByRole('button')
    .filter({ has: page.getByRole('heading', { name: '画面で作成したWorkflow', exact: true }) })
    .click();
  await page.getByRole('button', { name: '定義を編集', exact: true }).click();
  await expect(dialog.getByLabel('Stage ID', { exact: true })).toHaveValue('begin');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/workflow-editor-mobile.png', fullPage: true });
});

test('discovery selection imports native model IDs and runtime endpoints, then saves role binding', async ({
  page,
}) => {
  await page.route('**/api/models/discover', (route) =>
    route.fulfill({
      json: {
        checkedAt: new Date().toISOString(),
        sources: [
          {
            id: 'codex',
            name: 'Codex',
            status: 'login-required',
            message: 'codex login を実行してください。',
            models: [],
            provider: { id: 'openai', name: 'OpenAI' },
            runtime: { id: 'codex', name: 'Codex', provider: 'openai' },
          },
          {
            id: 'ollama',
            name: 'Ollama',
            status: 'connected',
            message: 'インストール済みモデル',
            models: [{ id: 'org/llama3.2:latest', name: 'Local Llama' }],
            provider: { id: 'ollama', name: 'Ollama' },
            runtime: {
              id: 'ollama',
              name: 'Ollama',
              provider: 'ollama',
              endpoint: 'http://127.0.0.1:11434',
            },
          },
        ],
      },
    }),
  );
  await page.goto('/#settings');
  await page.getByRole('button', { name: 'モデルを自動認識', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('ログインが必要', { exact: true })).toBeVisible();
  await dialog.getByRole('checkbox', { name: /Local Llama/ }).check();
  await page.screenshot({ path: 'test-results/model-discovery.png', fullPage: true });
  await dialog.getByRole('button', { name: '選択した1件を追加', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: /^Roleへの割り当て/ }).click();
  await page.getByRole('button', { name: '割り当てを追加', exact: true }).click();
  await dialog.getByLabel('Role', { exact: true }).selectOption('reviewer');
  await dialog.getByLabel('Model', { exact: true }).selectOption('org/llama3.2:latest');
  await expect(dialog.getByLabel('Runtime', { exact: true })).toHaveValue('ollama');
  await dialog.getByRole('button', { name: '割り当てる', exact: true }).click();
  await page.getByRole('button', { name: '設定を保存', exact: true }).click();
  await expect(page.getByRole('button', { name: '設定を保存', exact: true })).toBeDisabled();
  const state = await (await page.request.get('/api/state')).json();
  expect(state.config.runtimes.find((r: any) => r.id === 'ollama').endpoint).toBe(
    'http://127.0.0.1:11434',
  );
  expect(state.config.bindings.find((r: any) => r.role === 'reviewer').model).toBe(
    'org/llama3.2:latest',
  );
  await page.reload();
  await page.getByRole('button', { name: 'モデルを自動認識', exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: /Local Llama/ })).toBeDisabled();
  await expect(dialog.getByText('登録済み', { exact: true })).toBeVisible();
});
