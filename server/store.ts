import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import {
  assetSchema,
  defaultConfig,
  DomainError,
  type Asset,
  type State,
  type ChangeSet,
} from './domain.ts';

function atomicWrite(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
  if (process.platform !== 'win32') {
    const dir = fs.openSync(path.dirname(file), 'r');
    try {
      fs.fsyncSync(dir);
    } finally {
      fs.closeSync(dir);
    }
  }
}
function read<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
export class Store {
  readonly root: string;
  private lock: string;
  private closed = false;
  constructor(root: string) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true });
    this.lock = path.join(this.root, '.lock');
    if (fs.existsSync(this.lock)) {
      const owner = read<{ pid: number; host: string }>(this.lock);
      let alive = owner.host !== hostname();
      try {
        process.kill(owner.pid, 0);
        alive = true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') alive = true;
      }
      if (alive)
        throw new DomainError(
          'STORE_LOCKED',
          '同じデータを利用するCoreが既に起動しています。MCPはHTTPまたはstdio bridgeで接続してください。',
          409,
        );
      fs.unlinkSync(this.lock);
    }
    fs.writeFileSync(this.lock, JSON.stringify({ pid: process.pid, host: hostname() }), {
      flag: 'wx',
      mode: 0o600,
    });
    try {
      this.recover();
      if (!fs.existsSync(this.file('state.json')))
        this.commit(
          {
            schemaVersion: 1,
            projects: [],
            config: structuredClone(defaultConfig),
            runs: [],
            snapshots: [],
            journals: [],
            changesets: [],
            reviews: [],
          },
          [],
        );
      this.load();
    } catch (e) {
      this.close();
      throw e;
    }
  }
  private file(name: string) {
    return path.join(this.root, name);
  }
  private recover() {
    if (!fs.existsSync(this.file('transaction.json'))) return;
    const transaction = read<{ files: { path: string; value: unknown }[] }>(
      this.file('transaction.json'),
    );
    for (const entry of transaction.files) atomicWrite(entry.path, entry.value);
    fs.unlinkSync(this.file('transaction.json'));
  }
  load(): { state: State; assets: Asset[] } {
    this.recover();
    const state = read<State>(this.file('state.json'));
    if (state.schemaVersion !== 1)
      throw new DomainError(
        'STORE_VERSION',
        '未対応の保存形式です。データを変更せず停止しました。',
        500,
      );
    const assets = read<Asset[]>(this.file('assets.json'));
    for (const p of state.projects) {
      const marker = read<{ id: string }>(path.join(p.root, '.aacl', 'project.json'));
      if (marker.id !== p.id)
        throw new DomainError('PROJECT_ID', `Project IDが一致しません: ${p.root}`, 409);
      const local = read<Asset[]>(path.join(p.root, '.aacl', 'assets.json'));
      if (local.some((a) => a.projectId !== p.id))
        throw new DomainError('PROJECT_SCOPE', `Project Assetの所属が不正です: ${p.id}`, 409);
      assets.push(...local);
    }
    const ids = new Set<string>();
    for (const a of assets) {
      const { revision, updatedAt, ...input } = a;
      assetSchema.parse(input);
      if (!Number.isInteger(revision) || revision < 1 || !updatedAt || ids.has(a.id))
        throw new DomainError('ASSET_STORE', `AssetのrevisionまたはIDが不正です: ${a.id}`, 409);
      ids.add(a.id);
    }
    return { state, assets };
  }
  commit(state: State, assets: Asset[]) {
    const files = [
      { path: this.file('assets.json'), value: assets.filter((a) => !a.projectId) as unknown },
      { path: this.file('state.json'), value: state as unknown },
    ];
    for (const p of state.projects) {
      files.push({
        path: path.join(p.root, '.aacl', 'project.json'),
        value: { schemaVersion: 1, id: p.id, name: p.name },
      });
      files.push({
        path: path.join(p.root, '.aacl', 'assets.json'),
        value: assets.filter((a) => a.projectId === p.id),
      });
    }
    const changed = files.filter(
      (f) =>
        !fs.existsSync(f.path) ||
        fs.readFileSync(f.path, 'utf8') !== JSON.stringify(f.value, null, 2) + '\n',
    );
    if (!changed.length) return;
    atomicWrite(this.file('transaction.json'), { files: changed });
    this.recover();
  }
  transaction<T>(fn: (state: State, assets: Asset[]) => T): T {
    const { state, assets } = this.load();
    const result = fn(state, assets);
    this.commit(state, assets);
    return result;
  }
  gitRecord(change: ChangeSet): { gitCommit?: string; gitError?: string } {
    const dir = this.file('history');
    fs.mkdirSync(dir, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', dir, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15000,
      }).trim();
    try {
      if (!fs.existsSync(path.join(dir, '.git'))) git('init', '-q');
      for (const c of change.changes) {
        const file = path.join(dir, 'assets', `${c.id}.json`);
        if (c.after) atomicWrite(file, c.after);
        else if (fs.existsSync(file)) fs.unlinkSync(file);
      }
      atomicWrite(path.join(dir, 'change-set.json'), {
        id: change.id,
        origin: change.origin,
        reviewId: change.reviewId,
      });
      git('add', '--all');
      git(
        '-c',
        'user.name=AACL',
        '-c',
        'user.email=aacl@localhost',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-q',
        '-m',
        `AACL change set ${change.id}`,
      );
      return { gitCommit: git('rev-parse', 'HEAD') };
    } catch {
      return { gitError: 'Git履歴を保存できませんでした。AssetとChange Setの履歴は保存済みです。' };
    }
  }
  close() {
    if (!this.closed) {
      fs.unlinkSync(this.lock);
      this.closed = true;
    }
  }
}
