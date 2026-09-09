import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from './domain.ts';

// Native formats verified against official documentation:
// https://learn.chatgpt.com/docs/extend/mcp?surface=cli
// https://code.claude.com/docs/en/mcp
// https://cursor.com/guides/coding-agent-mcp
// Configuration bytes (including credentials) never leave this adapter. Its public
// functions return only paths, hashes, modes, status, and non-secret endpoint metadata.
const MAX_CONFIG = 2_000_000;
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const checksum = z.string().regex(/^[a-f0-9]{64}$/);
const absolutePath = z
  .string()
  .max(4096)
  .refine(
    (p) =>
      path.isAbsolute(p) &&
      !/[\x00-\x1f]/.test(p) &&
      !p.split(/[\\/]/).some((s) => s === '.' || s === '..'),
  );
const runtimeSchema = z.enum(['codex', 'claude', 'cursor']);
export const connectionFileSchema = z
  .object({
    path: absolutePath,
    kind: z.enum(['config', 'bootstrap']),
    beforeHash: checksum.nullable(),
    afterHash: checksum,
    beforeMode: z.number().int().min(0).max(0o777).optional(),
    backupPath: absolutePath.optional(),
    stagedPath: absolutePath,
    changed: z.boolean(),
    phase: z.enum(['prepared', 'installing', 'installed', 'restoring', 'restored']),
    creation: z
      .object({
        tempPath: absolutePath,
        dev: z.number().int().nonnegative(),
        ino: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const connectionStateSchema = z
  .object({
    version: z.literal(1),
    requestHash: checksum,
    endpoint: z.string(),
    userRequestHash: checksum,
    phase: z.enum(['prepared', 'installing', 'installed', 'restoring', 'restored']),
    targets: z
      .array(
        z
          .object({ runtime: runtimeSchema, configPath: absolutePath, bootstrapPath: absolutePath })
          .strict(),
      )
      .max(32),
    files: z.array(connectionFileSchema).max(64),
  })
  .strict();
export type NativeConnectionState = z.infer<typeof connectionStateSchema>;
type ConnectionFile = z.infer<typeof connectionFileSchema>;
export type NativeConnectionTarget = NativeConnectionState['targets'][number];

function check(ok: unknown, code: string, message: string): asserts ok {
  if (!ok) throw new DomainError(code, message, 409);
}
function exists(file: string) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}
function safe(file: string, missing = false) {
  absolutePath.parse(file);
  let parent = path.parse(file).root;
  const parts = file.slice(parent.length).split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    parent = path.join(parent, parts[i]);
    if (missing && !exists(parent)) return;
    const stat = fs.lstatSync(parent);
    check(
      !stat.isSymbolicLink() && (i === parts.length - 1 || stat.isDirectory()),
      'CONNECTION_UNSAFE_PATH',
      'Native connection paths must not contain symbolic links or non-directory ancestors',
    );
  }
}
function read(file: string, knownTwin?: { dev: number; ino: number }) {
  safe(file);
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const before = fs.fstatSync(fd);
    check(
      before.isFile() &&
        before.size <= MAX_CONFIG &&
        (knownTwin
          ? before.nlink === 2 && before.dev === knownTwin.dev && before.ino === knownTwin.ino
          : before.nlink === 1),
      'CONNECTION_UNSUPPORTED_FILE',
      'Native configuration must be a bounded regular UTF-8 file without hard links',
    );
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const n = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!n) break;
      length += n;
    }
    const after = fs.fstatSync(fd);
    check(
      length === before.size &&
        before.size === after.size &&
        before.nlink === after.nlink &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs,
      'CONNECTION_CONFLICT',
      'Configuration changed during reading',
    );
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        buffer.subarray(0, length),
      );
    } catch {
      throw new DomainError('CONNECTION_UNSUPPORTED_FILE', 'Native configuration must be UTF-8');
    }
    check(
      !content.includes('\0'),
      'CONNECTION_UNSUPPORTED_FILE',
      'Binary configuration is unsupported',
    );
    return {
      content,
      hash: digest(content),
      mode: before.mode & 0o777,
      ino: before.ino,
      dev: before.dev,
    };
  } finally {
    fs.closeSync(fd);
  }
}
function syncDir(directory: string) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function mkdir(directory: string) {
  safe(directory, true);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  safe(directory);
}
function writeNew(file: string, content: string, mode = 0o600) {
  check(
    Buffer.byteLength(content) <= MAX_CONFIG,
    'CONNECTION_TOO_LARGE',
    'Native connection file exceeds the byte limit',
  );
  mkdir(path.dirname(file));
  safe(file, true);
  const fd = fs.openSync(
    file,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    mode,
  );
  try {
    fs.fchmodSync(fd, mode);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  syncDir(path.dirname(file));
}
function compare(file: string, expected: string | null) {
  safe(file, true);
  if (expected === null)
    check(!exists(file), 'CONNECTION_CONFLICT', 'A native file appeared after preparation');
  else
    check(
      exists(file) && read(file).hash === expected,
      'CONNECTION_CONFLICT',
      'A native file changed after preparation; no overwrite was performed',
    );
}
function replace(
  file: string,
  content: string,
  expected: string | null,
  mode = 0o600,
  recordCreation?: (tempPath: string, stat: fs.Stats) => void,
) {
  compare(file, expected);
  const temp = path.join(path.dirname(file), `.aacl-connect-${randomUUID()}.tmp`);
  try {
    writeNew(temp, content, mode);
    compare(file, expected);
    if (expected === null && recordCreation) {
      // Exclusive creation: unlike rename, link cannot replace a concurrently created file.
      // Persist ownership before linking: a process exit after link must be recoverable.
      recordCreation(temp, fs.lstatSync(temp));
      compare(file, null);
      fs.linkSync(temp, file);
      fs.unlinkSync(temp);
    } else {
      // New metadata files are in the private, single-writer operation directory.
      // Publish them by rename so recovery never needs a hardlinked manifest to read.
      fs.renameSync(temp, file);
    }
    syncDir(path.dirname(file));
  } finally {
    // This is only the uniquely created staging file, never a user path.
    if (exists(temp)) fs.unlinkSync(temp);
  }
}
function snapshot(file: string, content: string) {
  if (exists(file)) {
    check(
      read(file).hash === digest(content),
      'CONNECTION_BACKUP_CONFLICT',
      'Connection backup already exists with different bytes',
    );
    return;
  }
  // Never write partial bytes to the permanent backup name. An interrupted private
  // temporary file is ignored on retry; an existing published backup is never replaced.
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeNew(temp, content);
    if (exists(file)) {
      check(
        read(file).hash === digest(content),
        'CONNECTION_BACKUP_CONFLICT',
        'Connection backup already exists with different bytes',
      );
    } else {
      compare(file, null);
      fs.renameSync(temp, file);
      syncDir(path.dirname(file));
    }
  } finally {
    if (exists(temp)) fs.unlinkSync(temp);
  }
}
function statePath(directory: string) {
  return path.join(directory, 'manifest.json');
}
function persist(directory: string, state: NativeConnectionState) {
  connectionStateSchema.parse(state);
  const target = statePath(directory);
  replace(target, JSON.stringify(state, null, 2) + '\n', exists(target) ? read(target).hash : null);
}
export function nativeConnectionStatus(directory: string): NativeConnectionState | undefined {
  safe(directory, true);
  if (!exists(statePath(directory))) return undefined;
  const state = connectionStateSchema.parse(JSON.parse(read(statePath(directory)).content));
  for (const file of state.files) {
    if (file.creation) {
      check(
        file.beforeHash === null &&
          file.phase === 'installing' &&
          path.dirname(file.creation.tempPath) === path.dirname(file.path) &&
          /^\.aacl-connect-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/.test(
            path.basename(file.creation.tempPath),
          ),
        'CONNECTION_MANIFEST',
        'Connection creation recovery metadata is invalid',
      );
    }
    check(
      (file.beforeHash === null) === (file.backupPath === undefined),
      'CONNECTION_MANIFEST',
      'Connection backup metadata is incomplete',
    );
    check(
      state.targets.some((t) =>
        file.kind === 'config' ? t.configPath === file.path : t.bootstrapPath === file.path,
      ),
      'CONNECTION_MANIFEST',
      'Connection manifest contains an unknown target',
    );
    const key = digest(file.path);
    check(
      file.stagedPath === path.join(directory, `${key}.after`) &&
        (!file.backupPath || file.backupPath === path.join(directory, `${key}.before`)),
      'CONNECTION_MANIFEST',
      'Connection backup path is invalid',
    );
  }
  return state;
}

function recoverCreation(directory: string, state: NativeConnectionState, file: ConnectionFile) {
  const creation = file.creation;
  if (!creation) return;
  safe(file.path, true);
  safe(creation.tempPath, true);
  const current = exists(file.path) ? fs.lstatSync(file.path) : undefined;
  if (exists(creation.tempPath)) {
    const temp = fs.lstatSync(creation.tempPath);
    const twin =
      current &&
      current.isFile() &&
      current.dev === creation.dev &&
      current.ino === creation.ino &&
      current.nlink === 2;
    check(
      temp.isFile() &&
        temp.dev === creation.dev &&
        temp.ino === creation.ino &&
        (current ? twin && temp.nlink === 2 : temp.nlink === 1),
      'CONNECTION_CONFLICT',
      'A recorded creation staging file or its native target changed',
    );
    // Only this recorded pair may temporarily have two links. Ordinary native files,
    // arbitrary matching-name links, and third links still fail the normal read guard.
    check(
      read(creation.tempPath, twin ? creation : undefined).hash === file.afterHash,
      'CONNECTION_CONFLICT',
      'A recorded creation staging file changed',
    );
    safe(creation.tempPath);
    safe(file.path, true);
    const checked = fs.lstatSync(creation.tempPath);
    check(
      checked.dev === temp.dev && checked.ino === temp.ino && checked.nlink === temp.nlink,
      'CONNECTION_CONFLICT',
      'Creation staging identity changed before cleanup',
    );
    if (current) {
      const target = fs.lstatSync(file.path);
      check(
        target.dev === creation.dev && target.ino === creation.ino && target.nlink === 2,
        'CONNECTION_CONFLICT',
        'Native creation identity changed before cleanup',
      );
    }
    fs.unlinkSync(creation.tempPath);
    syncDir(path.dirname(creation.tempPath));
  } else if (current) {
    const data = read(file.path);
    check(
      data.dev === creation.dev && data.ino === creation.ino && data.hash === file.afterHash,
      'CONNECTION_CONFLICT',
      'Native creation changed after staging cleanup',
    );
  }
  delete file.creation;
  persist(directory, state);
}

// Small, deliberately conservative TOML recognizer. Unsupported multiline values and
// array tables fail closed, so appending cannot turn a comment/string into active config.
function tomlPath(text: string): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest) {
    const match =
      /^(?:[A-Za-z0-9_-]+|"(?:[^"\\\x00-\x1f]|\\["\\bfnrt]|\\u[0-9a-fA-F]{4})*"|'[^'\x00-\x1f]*')/.exec(
        rest,
      );
    check(
      match,
      'CONNECTION_TOML_UNSUPPORTED',
      'Unsupported TOML key syntax; use the connection snippet',
    );
    const token = match[0];
    parts.push(
      token.startsWith('"')
        ? JSON.parse(token)
        : token.startsWith("'")
          ? token.slice(1, -1)
          : token,
    );
    rest = rest.slice(token.length).trim();
    if (!rest) break;
    check(rest.startsWith('.'), 'CONNECTION_TOML_UNSUPPORTED', 'Unsupported TOML dotted key');
    rest = rest.slice(1).trim();
    check(rest, 'CONNECTION_TOML_UNSUPPORTED', 'Incomplete TOML dotted key');
  }
  check(parts.length > 0, 'CONNECTION_TOML_UNSUPPORTED', 'Empty TOML key');
  return parts;
}
function tomlItems(text: string, separator: string) {
  const result: string[] = [];
  let quote = '',
    escaped = false,
    depth = 0,
    start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\' && quote === '"') escaped = true;
      else if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      check(depth >= 0, 'CONNECTION_TOML_UNSUPPORTED', 'Invalid TOML brackets');
    } else if (ch === separator && depth === 0) {
      result.push(text.slice(start, i));
      start = i + 1;
    }
  }
  check(
    !quote && depth === 0,
    'CONNECTION_TOML_UNSUPPORTED',
    'Multiline or unbalanced TOML requires manual configuration',
  );
  result.push(text.slice(start));
  return result;
}
function tomlValue(text: string, depth = 0): unknown {
  check(depth < 20, 'CONNECTION_TOML_UNSUPPORTED', 'TOML nesting exceeds the supported limit');
  const value = text.trim();
  if (/^"(?:[^"\\\x00-\x1f]|\\["\\bfnrt]|\\u[0-9a-fA-F]{4})*"$/.test(value))
    return JSON.parse(value);
  if (/^'[^'\x00-\x1f]*'$/.test(value)) return value.slice(1, -1);
  if (value === 'true' || value === 'false') return value === 'true';
  if (
    /^[+-]?(?:0|[1-9](?:_?[0-9])*)(?:\.[0-9](?:_?[0-9])*)?(?:[eE][+-]?[0-9](?:_?[0-9])*)?$/.test(
      value,
    )
  )
    return Number(value.replaceAll('_', ''));
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim().replace(/,$/, '');
    return inner ? tomlItems(inner, ',').map((s) => tomlValue(s, depth + 1)) : [];
  }
  if (value.startsWith('{') && value.endsWith('}')) {
    const keys = new Set<string>();
    const inner = value.slice(1, -1).trim();
    for (const item of inner ? tomlItems(inner, ',') : []) {
      const pieces = tomlItems(item, '=');
      check(pieces.length === 2, 'CONNECTION_TOML_UNSUPPORTED', 'Unsupported TOML inline table');
      const key = JSON.stringify(tomlPath(pieces[0]));
      check(!keys.has(key), 'CONNECTION_TOML_UNSUPPORTED', 'Duplicate TOML inline key');
      keys.add(key);
      tomlValue(pieces[1], depth + 1);
    }
    return { inlineTable: true };
  }
  throw new DomainError(
    'CONNECTION_TOML_UNSUPPORTED',
    'Unsupported TOML value; use the connection snippet without changing existing configuration',
  );
}
function parseToml(content: string) {
  const tables = new Set<string>();
  const values = new Map<string, unknown>();
  let table: string[] = [];
  for (const raw of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    // Strip comments only outside strings. Values in this supported subset fit on one line.
    let quote = '',
      escaped = false,
      end = raw.length;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === '\\' && quote === '"') escaped = true;
        else if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '#') {
        end = i;
        break;
      }
    }
    const line = raw.slice(0, end).trim();
    if (!line) continue;
    check(
      !quote && !line.includes('"""') && !line.includes("'''"),
      'CONNECTION_TOML_UNSUPPORTED',
      'Multiline TOML strings require manual configuration',
    );
    if (line.startsWith('[')) {
      check(
        line.endsWith(']') && !line.startsWith('[['),
        'CONNECTION_TOML_UNSUPPORTED',
        'Unsupported TOML table syntax',
      );
      table = tomlPath(line.slice(1, -1));
      const key = JSON.stringify(table);
      check(
        !tables.has(key) && !values.has(key),
        'CONNECTION_TOML_UNSUPPORTED',
        'Duplicate or conflicting TOML table',
      );
      for (let i = 1; i <= table.length; i++)
        check(
          !values.has(JSON.stringify(table.slice(0, i))),
          'CONNECTION_TOML_UNSUPPORTED',
          'A TOML value shadows a table',
        );
      tables.add(key);
    } else {
      const pieces = tomlItems(line, '=');
      check(pieces.length === 2, 'CONNECTION_TOML_UNSUPPORTED', 'Invalid TOML assignment');
      const keys = [...table, ...tomlPath(pieces[0])];
      const key = JSON.stringify(keys);
      check(
        !values.has(key) && !tables.has(key),
        'CONNECTION_TOML_UNSUPPORTED',
        'Duplicate or conflicting TOML key',
      );
      for (let i = 1; i < keys.length; i++)
        check(
          !values.has(JSON.stringify(keys.slice(0, i))),
          'CONNECTION_TOML_UNSUPPORTED',
          'A TOML value shadows a dotted key',
        );
      values.set(key, tomlValue(pieces[1]));
    }
  }
  return { tables, values };
}
function mergeCodex(original: string, endpoint: string) {
  const parsed = parseToml(original);
  const prefix = ['mcp_servers', 'aacl'];
  const key = (name?: string) => JSON.stringify(name ? [...prefix, name] : prefix);
  check(
    !parsed.values.has(JSON.stringify(['mcp_servers'])) && !parsed.values.has(key()),
    'CONNECTION_TOML_UNSUPPORTED',
    'Inline MCP maps require manual configuration',
  );
  const present =
    parsed.tables.has(key()) ||
    [...parsed.values.keys()].some(
      (v) => JSON.parse(v).slice(0, 2).join('.') === 'mcp_servers.aacl',
    );
  if (present) {
    check(
      parsed.values.get(key('url')) === endpoint &&
        !parsed.values.has(key('command')) &&
        parsed.values.get(key('enabled')) !== false,
      'CONNECTION_DEFINITION_CONFLICT',
      'An existing AACL server definition differs or is disabled',
    );
    return original;
  }
  const updated = `${original}${original && !original.endsWith('\n') ? '\n' : ''}\n[mcp_servers.aacl]\nurl = ${JSON.stringify(endpoint)}\n`;
  parseToml(updated);
  return updated;
}

type JsonNode = { start: number; end: number; fields?: Map<string, JsonNode> };
function jsonTree(text: string) {
  try {
    JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new DomainError('CONNECTION_JSON_INVALID', 'Existing configuration is not valid JSON');
  }
  let i = text.startsWith('\uFEFF') ? 1 : 0;
  const space = () => {
    while (/\s/.test(text[i] ?? '') && i < text.length) i++;
  };
  const string = () => {
    const start = i++;
    while (i < text.length) {
      if (text[i] === '\\') i += 2;
      else if (text[i++] === '"') return JSON.parse(text.slice(start, i)) as string;
    }
    throw new DomainError('CONNECTION_JSON_INVALID', 'Invalid JSON string');
  };
  const value = (depth: number): JsonNode => {
    check(
      depth < 100,
      'CONNECTION_JSON_INVALID',
      'Configuration nesting exceeds the supported limit',
    );
    space();
    const start = i;
    if (text[i] === '{') {
      i++;
      space();
      const fields = new Map<string, JsonNode>();
      while (text[i] !== '}') {
        const name = string();
        space();
        i++; // colon, already validated by JSON.parse
        check(
          !fields.has(name),
          'CONNECTION_JSON_INVALID',
          'Duplicate JSON keys are not safe to merge',
        );
        fields.set(name, value(depth + 1));
        space();
        if (text[i] !== ',') break;
        i++;
        space();
      }
      i++;
      return { start, end: i, fields };
    }
    if (text[i] === '[') {
      i++;
      space();
      while (text[i] !== ']') {
        value(depth + 1);
        space();
        if (text[i] !== ',') break;
        i++;
      }
      i++;
    } else if (text[i] === '"') string();
    else while (i < text.length && !/[\s,\]}]/.test(text[i])) i++;
    return { start, end: i };
  };
  return value(0);
}
function mergeJson(original: string, runtime: 'claude' | 'cursor', endpoint: string) {
  const root = jsonTree(original);
  check(root.fields, 'CONNECTION_JSON_INVALID', 'Native MCP configuration must be an object');
  const servers = root.fields.get('mcpServers');
  check(!servers || servers.fields, 'CONNECTION_JSON_INVALID', 'mcpServers must be an object');
  const existing = servers?.fields?.get('aacl');
  if (existing) {
    const entry = JSON.parse(original.slice(existing.start, existing.end));
    check(
      entry &&
        typeof entry === 'object' &&
        entry.url === endpoint &&
        !entry.command &&
        entry.disabled !== true &&
        entry.enabled !== false &&
        (runtime !== 'claude' || ['http', 'streamable-http'].includes(entry.type)),
      'CONNECTION_DEFINITION_CONFLICT',
      'An existing AACL server definition differs or is disabled',
    );
    return original;
  }
  const entry = JSON.stringify(
    runtime === 'claude' ? { type: 'http', url: endpoint } : { url: endpoint },
  );
  const container = servers ?? root;
  const insertion = `${container.fields!.size ? ',' : ''}\n  ${servers ? `"aacl": ${entry}` : `"mcpServers": { "aacl": ${entry} }`}\n`;
  const result =
    original.slice(0, container.end - 1) + insertion + original.slice(container.end - 1);
  jsonTree(result);
  return result;
}

/** Resolve only registered project locations or a known runtime directory ancestor.
 * An arbitrary skill import root must never redirect configuration writes to the real home. */
export function nativeConnectionTarget(
  root: { path: string; runtime: string },
  projectRoot?: string,
): NativeConnectionTarget {
  const runtime = runtimeSchema.parse(root.runtime);
  if (projectRoot) {
    safe(projectRoot);
    return {
      runtime,
      configPath:
        runtime === 'claude'
          ? path.join(projectRoot, '.mcp.json')
          : path.join(projectRoot, `.${runtime}`, runtime === 'codex' ? 'config.toml' : 'mcp.json'),
      bootstrapPath: path.join(projectRoot, 'AACL-BOOTSTRAP.md'),
    };
  }
  let directory = path.resolve(root.path);
  while (
    path.dirname(directory) !== directory &&
    path.basename(directory) !== `.${runtime}` &&
    !(runtime === 'codex' && path.basename(directory) === '.agents')
  )
    directory = path.dirname(directory);
  check(
    path.dirname(directory) !== directory,
    'CONNECTION_ROOT_REQUIRED',
    'Automatic connection requires a known runtime directory or registered project root',
  );
  if (runtime === 'codex' && path.basename(directory) === '.agents')
    directory = path.join(path.dirname(directory), '.codex');
  return {
    runtime,
    configPath:
      runtime === 'claude'
        ? path.join(path.dirname(directory), '.claude.json')
        : path.join(directory, runtime === 'codex' ? 'config.toml' : 'mcp.json'),
    bootstrapPath: path.join(directory, 'AACL-BOOTSTRAP.md'),
  };
}

/** Install exact AACL entries. Backup/staged contents are private files, not returned data. */
export function installNativeConnections(
  directory: string,
  targets: NativeConnectionTarget[],
  endpoint: string,
  userRequest: string,
  guide: string,
) {
  const url = new URL(endpoint);
  check(
    ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    'UNSAFE_ENDPOINT',
    'Use an HTTP(S) endpoint without credentials, query parameters, or fragments',
  );
  check(
    userRequest.trim() && targets.length > 0 && targets.length <= 32,
    'CONNECTION_REQUEST',
    'An explicit user request and supported runtime target are required',
  );
  const requestHash = digest(JSON.stringify({ targets, endpoint, userRequest }));
  let state = nativeConnectionStatus(directory);
  if (state) {
    check(
      state.requestHash === requestHash,
      'CONNECTION_REQUEST_CONFLICT',
      'Resume the original connection request for this operation',
    );
    check(
      !['restoring', 'restored'].includes(state.phase),
      'CONNECTION_RESTORED',
      'Create a new onboarding operation after restoring connections',
    );
  } else {
    const contents = new Map<
      string,
      { kind: ConnectionFile['kind']; before?: ReturnType<typeof read>; after: string }
    >();
    // Prepare all targets before changing any native file.
    for (const target of targets) {
      safe(target.configPath, true);
      safe(target.bootstrapPath, true);
      if (!contents.has(target.configPath)) {
        const before = exists(target.configPath) ? read(target.configPath) : undefined;
        const after =
          target.runtime === 'codex'
            ? mergeCodex(before?.content ?? '', endpoint)
            : mergeJson(before?.content ?? '{}\n', target.runtime, endpoint);
        contents.set(target.configPath, { kind: 'config', before, after });
      }
      if (!contents.has(target.bootstrapPath)) {
        const before = exists(target.bootstrapPath) ? read(target.bootstrapPath) : undefined;
        check(
          !before || before.content === guide,
          'CONNECTION_GUIDE_CONFLICT',
          'A different bootstrap guide already exists; it was not overwritten',
        );
        contents.set(target.bootstrapPath, { kind: 'bootstrap', before, after: guide });
      }
    }
    state = {
      version: 1,
      requestHash,
      endpoint,
      userRequestHash: digest(userRequest),
      phase: 'prepared',
      targets,
      files: [],
    };
    for (const [file, data] of contents) {
      const key = digest(file);
      const backupPath = data.before ? path.join(directory, `${key}.before`) : undefined;
      const stagedPath = path.join(directory, `${key}.after`);
      state.files.push({
        path: file,
        kind: data.kind,
        beforeHash: data.before?.hash ?? null,
        afterHash: digest(data.after),
        beforeMode: data.before?.mode,
        backupPath,
        stagedPath,
        changed: data.before?.content !== data.after,
        phase: 'prepared',
      });
    }
    // Record intent before snapshot I/O. Even a failure on the first backup can be
    // inspected, retried, or cancelled while every native file is still unchanged.
    persist(directory, state);
  }
  for (const file of state.files) {
    const hasBackup = !file.backupPath || exists(file.backupPath);
    const hasStaged = exists(file.stagedPath);
    if (hasBackup && hasStaged) {
      if (file.backupPath)
        check(
          read(file.backupPath).hash === file.beforeHash,
          'CONNECTION_BACKUP_CONFLICT',
          'Configuration backup changed',
        );
      check(
        read(file.stagedPath).hash === file.afterHash,
        'CONNECTION_BACKUP_CONFLICT',
        'Staged configuration changed',
      );
      continue;
    }
    check(
      file.phase === 'prepared',
      'CONNECTION_BACKUP_CONFLICT',
      'A committed connection snapshot is missing',
    );
    compare(file.path, file.beforeHash);
    const before = file.beforeHash === null ? undefined : read(file.path);
    const target = state.targets.find((t) => t.configPath === file.path);
    const after =
      file.kind === 'bootstrap'
        ? guide
        : target!.runtime === 'codex'
          ? mergeCodex(before?.content ?? '', endpoint)
          : mergeJson(before?.content ?? '{}\n', target!.runtime as 'claude' | 'cursor', endpoint);
    check(
      digest(after) === file.afterHash,
      'CONNECTION_BACKUP_CONFLICT',
      'Prepared connection content changed; restore or resume the original version',
    );
    if (file.backupPath) snapshot(file.backupPath, before!.content);
    snapshot(file.stagedPath, after);
  }
  state.phase = 'installing';
  persist(directory, state);
  for (const file of state.files) {
    recoverCreation(directory, state, file);
    safe(file.path, true);
    if (exists(file.path) && read(file.path).hash === file.afterHash) {
      file.phase = 'installed';
      persist(directory, state);
      continue;
    }
    check(
      file.phase !== 'installed',
      'CONNECTION_CONFLICT',
      'An installed connection was subsequently changed',
    );
    const staged = read(file.stagedPath);
    check(
      staged.hash === file.afterHash,
      'CONNECTION_BACKUP_CONFLICT',
      'Staged configuration changed',
    );
    if (file.backupPath)
      check(
        read(file.backupPath).hash === file.beforeHash,
        'CONNECTION_BACKUP_CONFLICT',
        'Configuration backup changed',
      );
    compare(file.path, file.beforeHash);
    file.phase = 'installing';
    persist(directory, state);
    replace(file.path, staged.content, file.beforeHash, 0o600, (tempPath, stat) => {
      file.creation = { tempPath, dev: stat.dev, ino: stat.ino };
      persist(directory, state!);
    });
    delete file.creation;
    file.phase = 'installed';
    persist(directory, state);
  }
  state.phase = 'installed';
  persist(directory, state);
  return state;
}

/** Preflight may be called before restoring imported assets to fail before any rollback. */
export function preflightNativeConnectionRestore(directory: string) {
  const state = nativeConnectionStatus(directory);
  if (!state) return;
  for (const file of state.files) {
    recoverCreation(directory, state, file);
    if (!file.changed) continue;
    safe(file.path, true);
    const currentHash = exists(file.path) ? read(file.path).hash : null;
    const untouched =
      ['prepared', 'installing'].includes(file.phase) && currentHash === file.beforeHash;
    const resumed =
      ['restoring', 'restored'].includes(file.phase) && currentHash === file.beforeHash;
    check(
      untouched || resumed || currentHash === file.afterHash,
      'CONNECTION_CONFLICT',
      'Native configuration changed after installation; restore did not overwrite it',
    );
    if (file.backupPath && (!untouched || exists(file.backupPath)))
      check(
        read(file.backupPath).hash === file.beforeHash,
        'CONNECTION_BACKUP_CONFLICT',
        'Configuration backup changed',
      );
  }
  return state;
}
export function restoreNativeConnections(directory: string) {
  const state = preflightNativeConnectionRestore(directory);
  if (!state || state.phase === 'restored') return state;
  state.phase = 'restoring';
  persist(directory, state);
  // Return native assets first (caller), then remove the connection and guide.
  for (const file of state.files) {
    if (file.phase === 'restored') continue;
    if (!file.changed) {
      file.phase = 'restored';
      persist(directory, state);
      continue;
    }
    const currentHash = exists(file.path) ? read(file.path).hash : null;
    if (currentHash === file.beforeHash) {
      file.phase = 'restored';
      persist(directory, state);
      continue;
    }
    check(
      currentHash === file.afterHash,
      'CONNECTION_CONFLICT',
      'Native configuration changed before restore',
    );
    file.phase = 'restoring';
    persist(directory, state);
    if (file.backupPath)
      replace(file.path, read(file.backupPath).content, file.afterHash, file.beforeMode ?? 0o600);
    else {
      compare(file.path, file.afterHash);
      fs.unlinkSync(file.path);
      syncDir(path.dirname(file.path));
    }
    file.phase = 'restored';
    persist(directory, state);
  }
  state.phase = 'restored';
  persist(directory, state);
  return state;
}
