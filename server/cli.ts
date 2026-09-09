import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { bundlePathSchema } from './domain.ts';

const base = process.env.AACL_API_URL ?? 'http://127.0.0.1:4780';
async function api(route: string, data?: unknown) {
  const stateResponse = await fetch(`${base}/api/state`).catch(() => {
    throw new Error(
      `AACL Coreへ接続できません（${base}）。Coreを起動し、AACL_API_URLを確認してください。`,
    );
  });
  if (!stateResponse.ok) throw new Error('Coreへ接続できません');
  const state = (await stateResponse.json()) as { humanToken: string };
  const response = await fetch(`${base}/api${route}`, {
    method: data ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-AACL-Token': state.humanToken },
    body: data ? JSON.stringify(data) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error((result as { error: string }).error);
  return result;
}
const [command, ...args] = process.argv.slice(2);
async function onboardingCli(args: string[]) {
  const [action, idOrFile, inputFile] = args;
  if (
    ![
      'discover',
      'connect',
      'import',
      'get',
      'list',
      'plan',
      'verify',
      'organize',
      'cutover',
      'restore',
    ].includes(action)
  )
    throw new Error(
      'Usage: onboarding <discover|connect|import|get|list|plan|verify|organize|cutover|restore> [id] [input.json]. Discover takes an optional input.json; connect, verify and organize require userRequest in input.json.',
    );
  const filename = action === 'discover' ? idOrFile : inputFile;
  let input: Record<string, unknown> = {};
  if (filename) {
    if (fs.statSync(filename).size > 4_000_000) throw new Error('Onboarding input exceeds 4 MB');
    const parsed: unknown = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('Onboarding input must be an object');
    input = parsed as Record<string, unknown>;
  }
  if (!['discover', 'list'].includes(action)) {
    if (!idOrFile) throw new Error('An onboarding operation ID is required');
    input = { ...input, id: idOrFile };
  }
  const client = new Client({ name: 'aacl-onboarding-cli', version: '0.1.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const call = async (name: string, request: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: request });
      if (result.isError)
        throw new Error(
          'MCP onboarding operation failed; inspect the operation status for its error code',
        );
      const content = result.content as { type: string; text?: string }[];
      const text = content.find((c) => c.type === 'text')?.text;
      if (!text) throw new Error('MCP returned no JSON result');
      return JSON.parse(text);
    };
    if (action === 'verify') {
      const status = await call('aacl_onboarding_get', { id: idOrFile });
      for (const candidate of status.candidates ?? []) {
        if (candidate.imported && status.selected?.includes(candidate.id))
          await call('aacl_asset_get', { id: candidate.id });
      }
    }
    return await call(`aacl_onboarding_${action}`, input);
  } finally {
    await client.close();
  }
}

function exportFiles(root: string, files: { path: string; content: string }[]) {
  const targets = files.map((file) => {
    bundlePathSchema.parse(file.path);
    return path.resolve(root, file.path);
  });
  if (new Set(targets.map((p) => p.toLowerCase())).size !== targets.length)
    throw new Error('Generated output contains colliding file paths');
  let ancestor = path.dirname(root);
  while (true) {
    if (fs.existsSync(ancestor) && fs.lstatSync(ancestor).isSymbolicLink())
      throw new Error('Export ancestors must not be symbolic links');
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  fs.mkdirSync(path.dirname(root), { recursive: true });
  // A single exclusive mkdir rejects existing files, directories and dangling symlinks.
  fs.mkdirSync(root, { mode: 0o700 });
  files.forEach((file, index) => {
    const target = targets[index];
    if (!target.startsWith(root + path.sep)) throw new Error('Invalid export path');
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, file.content, { flag: 'wx', mode: 0o600 });
  });
}
try {
  if (command === 'onboarding' || command === 'onboard')
    console.log(JSON.stringify(await onboardingCli(args), null, 2));
  else if (command === 'mcp') {
    if (args.length) throw new Error('使い方: aacl mcp');
    await import('./stdio.ts');
  } else if (command === 'init') {
    if (args.length > 2) throw new Error('使い方: aacl init [path] [name]');
    const root = path.resolve(args[0] ?? '.');
    console.log(
      JSON.stringify(
        await api('/projects', {
          root,
          name: args[1] ?? path.basename(root),
        }),
        null,
        2,
      ),
    );
  } else if (command === 'start')
    console.log(JSON.stringify(await api('/runs', { command: args.join(' ') }), null, 2));
  else if (command === 'export-bundle') {
    const [inputFile, output] = args;
    if (!inputFile || !output || args.length !== 2)
      throw new Error('使い方: export-bundle input.json new-directory');
    if (fs.statSync(inputFile).size > 1_000_000) throw new Error('Export input exceeds 1 MB');
    const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    const result = (await api('/export-bundle', input)) as {
      files: { path: string; content: string }[];
      limitations: unknown;
    };
    const root = path.resolve(output);
    exportFiles(root, result.files);
    console.log(
      JSON.stringify(
        { output: root, files: result.files.length, limitations: result.limitations },
        null,
        2,
      ),
    );
  } else if (command === 'export') {
    const [runtime, workflow, output] = args;
    if (!['codex', 'claude', 'cursor', 'other'].includes(runtime) || !output)
      throw new Error('使い方: aacl export codex issue-development ./generated');
    const result = (await api('/materialize', { runtime, context: { workflow } })) as {
      files: { path: string; content: string }[];
    };
    const root = path.resolve(output);
    if (fs.existsSync(root)) throw new Error('export先には新しいディレクトリを指定してください');
    exportFiles(root, result.files);
    console.log(`生成しました: ${root}`);
  } else if (command === 'status') console.log(JSON.stringify(await api('/health'), null, 2));
  else {
    console.log(
      'aacl Core CLI\n  init [path] [name]  対象Projectを登録（path省略時は現在のディレクトリ）\n  mcp                 稼働中のCoreへ標準入出力で接続\n  start /workflow additional instruction\n  export <codex|claude|cursor|other> <workflow> <new-directory>\n  export-bundle input.json <new-directory>\n  onboarding <discover|connect|import|get|list|plan|verify|organize|cutover|restore> [id] [input.json]\n  status\nCoreを先に起動してください。initを再実行すると既存のProject IDを返します。',
    );
    if (command && command !== '--help' && command !== '-h') process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
