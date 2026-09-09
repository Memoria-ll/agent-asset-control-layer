import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { modelIdSchema, type Config, DomainError } from './domain.ts';

export type DiscoveredSource = {
  id: string;
  name: string;
  status: 'connected' | 'login-required' | 'unavailable' | 'error';
  message: string;
  models: { id: string; name: string }[];
  provider: Config['providers'][number];
  runtime: Config['runtimes'][number];
};
export type Discovery = { checkedAt: string; sources: DiscoveredSource[] };
export const discoveryInput = z
  .object({
    ollama: z.string().optional(),
    lmstudio: z.string().optional(),
    llamacpp: z.string().optional(),
  })
  .strict();
type Input = z.infer<typeof discoveryInput>;
const timeout = 15000;
const maxBytes = 2 * 1024 * 1024;

// No shell, generation request, thread creation, or task input is used during discovery.
class JsonLines {
  private proc;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private buffer = '';
  private bytes = 0;
  private failure: Error | null = null;
  private nextId = 0;
  private timer;
  constructor(
    command: string,
    args: string[],
    private claude = false,
  ) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_SAFE_MODE: '1',
    };
    delete env.CLAUDECODE;
    this.proc = spawn(command, args, {
      cwd: os.tmpdir(),
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.timer = setTimeout(() => this.fail(new Error('応答がタイムアウトしました')), timeout);
    this.proc.on('error', () => this.fail(new Error('CLIを起動できません')));
    this.proc.on('exit', () => this.fail(new Error('CLIとの接続が終了しました')));
    this.proc.stdin.on('error', () => this.fail(new Error('CLIに接続できません')));
    this.proc.stderr.resume(); // Never expose CLI diagnostics, which can contain account information.
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => {
      this.bytes += Buffer.byteLength(chunk);
      if (this.bytes > maxBytes) return this.fail(new Error('CLIの応答が大きすぎます'));
      this.buffer += chunk;
      let end;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        try {
          const msg = JSON.parse(line);
          const body = this.claude ? msg.response : msg;
          const id = String(this.claude ? body?.request_id : body?.id);
          const pending = this.pending.get(id);
          if (!pending) continue;
          this.pending.delete(id);
          if (body.error || body.subtype === 'error')
            pending.reject(new Error('CLIが一覧の取得を拒否しました'));
          else pending.resolve(this.claude ? body.response : body.result);
        } catch {
          /* Ignore non-protocol startup output. */
        }
      }
    });
  }
  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    this.pending.forEach((p) => p.reject(error));
    this.pending.clear();
    this.close();
  }
  send(value: unknown) {
    this.proc.stdin.write(JSON.stringify(value) + '\n');
  }
  request(method: string, params: unknown = {}): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    const id = String(++this.nextId);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send(
        this.claude
          ? {
              type: 'control_request',
              request_id: id,
              request: { subtype: method, ...(params as object) },
            }
          : { id, method, params },
      );
    });
  }
  close() {
    clearTimeout(this.timer);
    this.proc.stdin.destroy();
    this.proc.kill('SIGKILL');
  }
}

async function executable(name: string): Promise<string | undefined> {
  const override = process.env[`AACL_${name.toUpperCase()}_BIN`];
  const paths = override
    ? [override]
    : [
        path.join(os.homedir(), '.local', 'bin', name),
        ...(process.env.PATH ?? '')
          .split(path.delimiter)
          .filter(Boolean)
          .map((p) => path.join(p, process.platform === 'win32' ? `${name}.exe` : name)),
      ];
  for (const file of paths) {
    try {
      await fs.access(file, fs.constants.X_OK);
      return file;
    } catch {
      /* Try next installation. */
    }
  }
}
function jsonCommand(command: string, args: string[]): Promise<any> {
  return new Promise((resolve, reject) =>
    execFile(
      command,
      args,
      { cwd: os.tmpdir(), timeout, maxBuffer: maxBytes, windowsHide: true },
      (_error, stdout) => {
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('認証状態を取得できません'));
        }
      },
    ),
  );
}
const catalogModels = z.array(z.object({ id: modelIdSchema, name: z.string().min(1) })).max(2000);
function models(items: unknown): DiscoveredSource['models'] {
  return [...new Map(catalogModels.parse(items).map((m) => [m.id, m])).values()];
}
const codexBase = {
  id: 'codex',
  name: 'Codex',
  provider: { id: 'openai', name: 'OpenAI' },
  runtime: { id: 'codex', name: 'Codex', provider: 'openai' },
};
export async function discoverCodex(command?: string): Promise<DiscoveredSource> {
  command ??= await executable('codex');
  if (!command)
    return {
      ...codexBase,
      status: 'unavailable',
      message: 'Codex CLIが見つかりません。インストール後に再取得してください。',
      models: [],
    };
  const rpc = new JsonLines(command, ['app-server', '-c', 'model_provider="openai"']);
  try {
    await rpc.request('initialize', {
      clientInfo: { name: 'aacl_model_discovery', version: '0.1.0' },
    });
    rpc.send({ method: 'initialized', params: {} });
    const account = await rpc.request('account/read', { refreshToken: false });
    if (!account?.account)
      return {
        ...codexBase,
        status: 'login-required',
        message: '同じ環境のターミナルで codex login を実行してください。',
        models: [],
      };
    const result: { id: string; name: string }[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const page = await rpc.request('model/list', { limit: 100, includeHidden: false, cursor });
      if (!Array.isArray(page?.data)) throw new Error('モデル一覧の形式が不正です');
      result.push(
        ...page.data.map((m: any) => ({
          id: m.model ?? m.id,
          name: m.displayName ?? m.model ?? m.id,
        })),
      );
      cursor = page.nextCursor;
      if (cursor) {
        if (seen.has(cursor) || seen.size >= 20) throw new Error('モデル一覧のページが不正です');
        seen.add(cursor);
      }
    } while (cursor);
    return {
      ...codexBase,
      status: 'connected',
      message: 'ログイン済み · Codexのモデル一覧を取得しました。',
      models: models(result),
    };
  } catch (e) {
    return { ...codexBase, status: 'error', message: safeError(e), models: [] };
  } finally {
    rpc.close();
  }
}

const claudeBase = {
  id: 'claude',
  name: 'Claude Code',
  provider: { id: 'anthropic', name: 'Anthropic' },
  runtime: { id: 'claude', name: 'Claude Code', provider: 'anthropic' },
};
export async function discoverClaude(command?: string): Promise<DiscoveredSource> {
  command ??= await executable('claude');
  if (!command)
    return {
      ...claudeBase,
      status: 'unavailable',
      message: 'Claude Codeが見つかりません。インストール後に再取得してください。',
      models: [],
    };
  let rpc: JsonLines | undefined;
  try {
    const auth = await jsonCommand(command, ['auth', 'status']);
    if (auth.loggedIn !== true)
      return {
        ...claudeBase,
        status: 'login-required',
        message: '同じ環境のターミナルで claude auth login を実行してください。',
        models: [],
      };
    rpc = new JsonLines(
      command,
      [
        '--print',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--no-session-persistence',
        '--setting-sources',
        '',
        '--settings',
        '{"disableAllHooks":true}',
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{}}',
        '--tools',
        '',
        '--disable-slash-commands',
      ],
      true,
    );
    const info = await rpc.request('initialize', { hooks: {} });
    if (!Array.isArray(info?.models)) throw new Error('モデル一覧の形式が不正です');
    return {
      ...claudeBase,
      status: 'connected',
      message: 'ログイン済み · Claude Codeが返すモデル名・エイリアスを取得しました。',
      models: models(
        info.models.map((m: any) => ({ id: m.value, name: m.displayName ?? m.value })),
      ),
    };
  } catch (e) {
    return { ...claudeBase, status: 'error', message: safeError(e), models: [] };
  } finally {
    rpc?.close();
  }
}

function safeError(error: unknown) {
  return error instanceof z.ZodError
    ? 'モデル一覧の形式に対応していません。'
    : error instanceof Error
      ? error.message
      : '一覧を取得できませんでした。';
}
export function localEndpoint(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DomainError('INPUT', 'ローカルサーバーのURLを確認してください');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const privateHost =
    host === 'localhost' ||
    host === '::1' ||
    /^127\.\d+\.\d+\.\d+$/.test(host) ||
    /^10\.\d+\.\d+\.\d+$/.test(host) ||
    /^192\.168\.\d+\.\d+$/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !privateHost ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new DomainError('INPUT', 'localhostまたはプライベートIPのHTTP URLを指定してください');
  url.pathname = url.pathname.replace(/\/(v1|api)\/?$/, '').replace(/\/$/, '');
  return url.toString().replace(/\/$/, '');
}

async function readJson(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3500), redirect: 'error' });
  if (!response.ok) throw new Error(`接続先がHTTP ${response.status}を返しました。`);
  if (!response.body) throw new Error('モデル一覧が空です。');
  let size = 0;
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new Error('モデル一覧が大きすぎます。');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
export async function discoverLocal(
  id: 'ollama' | 'lmstudio' | 'llamacpp',
  endpoint: string,
): Promise<DiscoveredSource> {
  const name = { ollama: 'Ollama', lmstudio: 'LM Studio', llamacpp: 'llama.cpp' }[id];
  const base = {
    id,
    name,
    provider: { id, name },
    runtime: { id, name, provider: id, endpoint: localEndpoint(endpoint) },
  };
  try {
    const body = await readJson(
      `${base.runtime.endpoint}${id === 'ollama' ? '/api/tags' : '/v1/models'}`,
    );
    const items = id === 'ollama' ? body.models : body.data;
    if (!Array.isArray(items)) throw new Error('モデル一覧の形式が不正です');
    return {
      ...base,
      status: 'connected',
      message: `${base.runtime.endpoint} · ${id === 'ollama' ? 'インストール済みモデル' : 'サーバーのモデル一覧'}`,
      models: models(
        items.map((m: any) => ({ id: id === 'ollama' ? m.name : m.id, name: m.name ?? m.id })),
      ),
    };
  } catch (e) {
    return {
      ...base,
      status: 'unavailable',
      message:
        e instanceof Error && e.message.startsWith('接続先')
          ? e.message
          : '接続できません。サーバーの起動状態とURLを確認してください。',
      models: [],
    };
  }
}

export async function discoverModels(input: Input = {}): Promise<Discovery> {
  const endpoints = {
    ollama: localEndpoint(input.ollama ?? process.env.AACL_OLLAMA_URL ?? 'http://127.0.0.1:11434'),
    lmstudio: localEndpoint(
      input.lmstudio ?? process.env.AACL_LMSTUDIO_URL ?? 'http://127.0.0.1:1234',
    ),
    llamacpp: localEndpoint(
      input.llamacpp ?? process.env.AACL_LLAMACPP_URL ?? 'http://127.0.0.1:8080',
    ),
  };
  const results = await Promise.allSettled([
    discoverCodex(),
    discoverClaude(),
    ...Object.entries(endpoints).map(([id, url]) =>
      discoverLocal(id as keyof typeof endpoints, url),
    ),
  ]);
  return {
    checkedAt: new Date().toISOString(),
    sources: results.map((result) => {
      if (result.status === 'rejected')
        throw new DomainError('DISCOVERY', 'モデルの認識に失敗しました');
      return result.value;
    }),
  };
}

// Coalesce repeated clicks; do not accumulate CLI child processes.
export function discoveryService(discover = discoverModels) {
  let pending: Promise<Discovery> | null = null;
  let key = '';
  return (input: Input) => {
    const nextKey = JSON.stringify(input);
    if (pending) {
      if (key !== nextKey)
        throw new DomainError('BUSY', '認識中です。完了後に再取得してください。', 409);
      return pending;
    }
    key = nextKey;
    pending = discover(input).finally(() => {
      pending = null;
    });
    return pending;
  };
}
