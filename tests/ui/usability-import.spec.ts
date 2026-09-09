import { test as base, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { Core } from '../../server/core.ts';
import { Store } from '../../server/store.ts';
import { createApp, errorHandler, serveProduction } from '../../server/app.ts';
import { assetSchema } from '../../server/domain.ts';
import type { Overview } from '../../src/api.ts';

// Each test has its own data directory and port; no starter/shared-suite state is used.
const test = base.extend<{ isolatedURL: string }>({
  isolatedURL: async ({}, use) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aacl-usability-import-'));
    const store = new Store(directory);
    const app = createApp(new Core(store));
    serveProduction(app, path.resolve(import.meta.dirname, '../..'));
    app.use(errorHandler);
    const server = app.listen(0, '127.0.0.1');
    try {
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture port');
      await use(`http://127.0.0.1:${address.port}`);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      store.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  baseURL: async ({ isolatedURL }, use) => use(isolatedURL),
});

async function state(page: Page): Promise<Overview> {
  const response = await page.request.get('/api/state');
  expect(response.ok()).toBe(true);
  return response.json();
}

async function openImport(page: Page) {
  await page.goto('/#assets');
  await page.getByRole('button', { name: 'インポート', exact: true }).click();
  return page.getByRole('dialog');
}

function markdown(content: string, name = 'SKILL.md') {
  return { name, mimeType: 'text/markdown', buffer: Buffer.from(content) };
}

test('file selection replaces automatic names using simple frontmatter or the current filename', async ({
  page,
}) => {
  const dialog = await openImport(page);
  for (const [source, expected] of [
    ['---\nname: first-skill\n---\nFirst body', 'first-skill'],
    ['---\nname: "Second skill"\n---\nSecond body', 'Second skill'],
    ["---\r\nname: 'Third skill'\r\n---\r\nThird body", 'Third skill'],
    ['---\nname:\ndescription: No name\n---\nFourth body', 'SKILL'],
    ['---\nname: |\n  Complex name\n---\nFifth body', 'SKILL'],
  ]) {
    await dialog.getByLabel('Markdownファイル', { exact: true }).setInputFiles(markdown(source));
    await expect(dialog.getByLabel('名前', { exact: true })).toHaveValue(expected);
    // The browser normalizes CRLF when exposing a textarea's value.
    await expect(dialog.getByLabel('本文 / SKILL.md', { exact: true })).toHaveValue(
      source.replace(/\r\n/g, '\n'),
    );
  }
  await dialog
    .getByLabel('Markdownファイル', { exact: true })
    .setInputFiles(markdown('# Notes', 'notes.md'));
  await expect(dialog.getByLabel('名前', { exact: true })).toHaveValue('notes');
  await expect(dialog.getByLabel('ID', { exact: true })).toHaveValue('');
});

for (const manualFirst of [true, false]) {
  test(`manual name survives file selection and pasting (entered ${manualFirst ? 'before' : 'after'} suggestion)`, async ({
    page,
  }) => {
    const dialog = await openImport(page);
    const name = dialog.getByLabel('名前', { exact: true });
    if (manualFirst) await name.fill('自分で決めた名前');
    await dialog
      .getByLabel('Markdownファイル', { exact: true })
      .setInputFiles(markdown('---\nname: suggested\n---\nBody'));
    await expect(name).toHaveValue(manualFirst ? '自分で決めた名前' : 'suggested');
    if (!manualFirst) await name.fill('自分で決めた名前');
    await dialog
      .getByLabel('Markdownファイル', { exact: true })
      .setInputFiles(markdown('---\nname: another\n---\nNew body'));
    await expect(dialog.getByLabel('本文 / SKILL.md', { exact: true })).toHaveValue(
      '---\nname: another\n---\nNew body',
    );
    await expect(name).toHaveValue('自分で決めた名前');
    await dialog
      .getByLabel('本文 / SKILL.md', { exact: true })
      .fill('---\nname: pasted\n---\nPasted body');
    await expect(name).toHaveValue('自分で決めた名前');
  });
}

test('pasting updates an untouched suggestion and removes a stale name when metadata disappears', async ({
  page,
}) => {
  const dialog = await openImport(page);
  await dialog
    .getByLabel('本文 / SKILL.md', { exact: true })
    .fill('---\nname: pasted-name\n---\nBody');
  await expect(dialog.getByLabel('名前', { exact: true })).toHaveValue('pasted-name');
  await dialog
    .getByLabel('本文 / SKILL.md', { exact: true })
    .fill('---\nname: "Updated name"\n---\nBody');
  await expect(dialog.getByLabel('名前', { exact: true })).toHaveValue('Updated name');
  await dialog.getByLabel('本文 / SKILL.md', { exact: true }).fill('# No metadata');
  await expect(dialog.getByLabel('名前', { exact: true })).toHaveValue('');
});

test('a slower previous file read cannot replace the latest selected file', async ({ page }) => {
  const dialog = await openImport(page);
  await page.evaluate(() => {
    const read = File.prototype.text;
    File.prototype.text = function () {
      if (this.name !== 'slow.md') return read.call(this);
      return new Promise<string>((resolve) => {
        Object.assign(window, { finishSlowRead: () => resolve('---\nname: stale\n---\nOld body') });
      });
    };
  });
  await dialog
    .getByLabel('Markdownファイル', { exact: true })
    .setInputFiles(markdown('Old body', 'slow.md'));
  await expect(dialog.getByRole('button', { name: '取り込む', exact: true })).toBeDisabled();
  const latest = '---\nname: latest\n---\nLatest body';
  await dialog.getByLabel('Markdownファイル', { exact: true }).setInputFiles(markdown(latest));
  await expect(dialog.getByLabel('名前', { exact: true })).toHaveValue('latest');
  await page.evaluate(() => (window as unknown as { finishSlowRead: () => void }).finishSlowRead());
  await expect(dialog.getByLabel('名前', { exact: true })).toHaveValue('latest');
  await expect(dialog.getByLabel('本文 / SKILL.md', { exact: true })).toHaveValue(latest);
});

test('single registration explains its effects and provides a copyable, ordered migration request', async ({
  page,
  context,
}) => {
  const dialog = await openImport(page);
  await expect(
    dialog.getByRole('heading', { name: '単一Markdownを登録', exact: true }),
  ).toBeVisible();
  await expect(dialog).toContainText('登録直後から有効になります');
  await expect(dialog).toContainText('元のパス・ハッシュ・補助ファイルは保存しません');
  await expect(dialog).toContainText('名前を手入力した後は');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const before = await state(page);
  const guidance = dialog.getByRole('region', { name: 'AIに移行・初期設定を依頼' });
  await guidance.getByText('移行の依頼文を確認', { exact: true }).click();
  await expect(guidance.locator('pre')).toBeVisible();
  await guidance.getByRole('button', { name: '移行の依頼をコピー', exact: true }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(await guidance.locator('pre').textContent());
  for (const tool of [
    'discover',
    'import',
    'plan',
    'connect',
    'verify',
    'organize',
    'cutover',
    'restore',
  ]) {
    expect(copied).toContain(`aacl_onboarding_${tool}`);
  }
  expect(copied.indexOf('aacl_onboarding_verify')).toBeLessThan(
    copied.indexOf('aacl_onboarding_organize'),
  );
  expect(copied.indexOf('aacl_onboarding_organize')).toBeLessThan(
    copied.indexOf('aacl_onboarding_connect'),
  );
  expect(copied).toContain('既に接続済みなら設定を繰り返す必要はありません');
  expect(copied).toContain('バックアップ');
  expect(copied).toContain('通常のREADMEやプロジェクト資料は元の場所に残してください');
  expect(copied).toContain('そのIDをidとして渡し');
  expect(copied).toContain(`${new URL(page.url()).origin}/mcp`);
  expect((await state(page)).assets).toEqual(before.assets);
  await expect(dialog).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

for (const manualName of [false, true]) {
  test(`registration keeps description and body semantics with ${manualName ? 'an edited' : 'the suggested'} name`, async ({
    page,
  }) => {
    const dialog = await openImport(page);
    const body = '# Original body\n\nKeep **formatting** and trailing spaces.  \n';
    const source = `---\nname: "source-name"\ndescription: "Original description"\nscope: ignored\n---\n${body}`;
    await dialog.getByLabel('Markdownファイル', { exact: true }).setInputFiles(markdown(source));
    await expect(dialog.getByLabel('名前', { exact: true })).toHaveValue('source-name');
    await dialog.getByLabel('ID', { exact: true }).fill('usability-imported-skill');
    if (manualName) await dialog.getByLabel('名前', { exact: true }).fill('画面で編集した名前');
    await expect(dialog.getByLabel('本文 / SKILL.md', { exact: true })).toHaveValue(source);
    await dialog.getByRole('button', { name: '取り込む', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const saved = (await state(page)).assets.find(
      (asset) => asset.id === 'usability-imported-skill',
    );
    expect(saved).toMatchObject({
      name: manualName ? '画面で編集した名前' : 'source-name',
      description: 'Original description',
      content: body,
      enabled: true,
      activation: 'on-demand',
      scope: {},
    });
    expect(saved?.sources).toBeUndefined();
    expect(saved?.files).toBeUndefined();
  });
}

test('file guidance is read-only, includes saved identity and preserves files on an unrelated edit', async ({
  page,
  context,
}) => {
  const initial = await state(page);
  const files = {
    'references/check.md': 'Original checklist',
    'scripts/helper.py': 'print("keep")\n',
  };
  const sources = [{ host: 'test-host', path: '/source/example/SKILL.md', hash: 'original-hash' }];
  const response = await page.request.post('/api/assets/change', {
    headers: { 'X-AACL-Token': initial.humanToken },
    data: {
      summary: 'Isolated file guidance fixture',
      operations: [
        {
          op: 'upsert',
          expectedRevision: 0,
          asset: assetSchema.parse({
            id: 'usability-files',
            name: '補助ファイルの確認対象',
            type: 'skill',
            content: 'Skill body',
            files,
            sources,
          }),
        },
      ],
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const before = await state(page);
  const asset = before.assets.find((item) => item.id === 'usability-files')!;
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/#assets');
  await page.getByRole('button', { name: '補助ファイルの確認対象の詳細', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const guidance = dialog.getByRole('region', { name: '補助ファイルと出所' });
  await expect(guidance.getByText('読み取り専用', { exact: true })).toBeVisible();
  await guidance
    .getByRole('button', { name: '補助ファイル更新の依頼をコピー', exact: true })
    .click();
  const request = await page.evaluate(() => navigator.clipboard.readText());
  expect(request).toContain('ID "usability-files"');
  expect(request).toContain(`改訂番号）は ${asset.revision} です`);
  expect(request).toContain('aacl_asset_change');
  expect(request).toContain('expectedRevision: 取得した現在のrevision');
  expect(request).toContain('actorはオブジェクト');
  expect(request).toContain('kind: "runtime"');
  expect(request).toContain('userId: 実際の依頼者ID');
  expect(request).toContain('変更しない補助ファイルをすべて保持');
  expect((await state(page)).assets).toEqual(before.assets);
  await dialog.getByRole('button', { name: '編集する', exact: true }).click();
  await expect(guidance.getByText('読み取り専用', { exact: true })).toBeVisible();
  await guidance
    .getByRole('button', { name: '補助ファイル更新の依頼をコピー', exact: true })
    .click();
  const editRequest = await page.evaluate(() => navigator.clipboard.readText());
  expect(editRequest).toContain('ID "usability-files"');
  expect(editRequest).toContain('現在の値を取得してください');
  await dialog.getByLabel('説明', { exact: true }).fill('説明だけを変更');
  await dialog.getByRole('button', { name: 'Assetを保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const saved = (await state(page)).assets.find((item) => item.id === asset.id)!;
  expect(saved.description).toBe('説明だけを変更');
  expect(saved.files).toEqual(files);
  expect(saved.sources).toEqual(sources);
});
