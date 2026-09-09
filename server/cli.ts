import fs from 'node:fs';
import path from 'node:path';

const base = process.env.AACL_API_URL ?? 'http://127.0.0.1:4780';
async function api(route: string, data?: unknown) {
  const stateResponse = await fetch(`${base}/api/state`);
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
try {
  if (command === 'init')
    console.log(
      JSON.stringify(
        await api('/projects', {
          root: path.resolve(args[0] ?? '.'),
          name: args[1] ?? path.basename(path.resolve(args[0] ?? '.')),
        }),
        null,
        2,
      ),
    );
  else if (command === 'start')
    console.log(JSON.stringify(await api('/runs', { command: args.join(' ') }), null, 2));
  else if (command === 'export') {
    const [runtime, workflow, output] = args;
    if (!['codex', 'claude'].includes(runtime) || !output)
      throw new Error('使い方: npm run cli -- export codex issue-development ./generated');
    const result = (await api('/materialize', { runtime, context: { workflow } })) as {
      files: { path: string; content: string }[];
    };
    const root = path.resolve(output);
    if (fs.existsSync(root)) throw new Error('export先には新しいディレクトリを指定してください');
    for (const file of result.files) {
      const target = path.resolve(root, file.path);
      if (!target.startsWith(root + path.sep)) throw new Error('Invalid export path');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.content, { flag: 'wx' });
    }
    console.log(`生成しました: ${root}`);
  } else if (command === 'status') console.log(JSON.stringify(await api('/health'), null, 2));
  else {
    console.log(
      'aacl Core CLI\n  init [path] [name]\n  start /workflow additional instruction\n  export <codex|claude> <workflow> <new-directory>\n  status\nCoreを先に起動してください。',
    );
    if (command) process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
