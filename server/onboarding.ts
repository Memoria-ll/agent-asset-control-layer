import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Core } from './core.ts';
import {
  assetSchema,
  DomainError,
  idSchema,
  inputOf,
  operationSchema,
  type Asset,
} from './domain.ts';
import { bootstrap, onboardingConnectionPlan } from './adapters.ts';
import {
  connectionStateSchema,
  installNativeConnections,
  nativeConnectionStatus,
  nativeConnectionTarget,
  preflightNativeConnectionRestore,
  restoreNativeConnections,
} from './native-connection.ts';

// Discovery/import never read native configuration. Optional connection installation
// delegates private configuration I/O to native-connection.ts. Limits bound discovery work.
const MAX_FILE = 200_000;
const MAX_BUNDLE = 2_000_000;
const MAX_FILES = 200;
const MAX_ASSETS = 100;
const MAX_SCAN = 5_000;
const MAX_TOTAL = 20_000_000;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const runtimeSchema = z.enum(['codex', 'claude', 'cursor', 'other']);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const nativePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (p) =>
      path.isAbsolute(p) &&
      !p.includes('\0') &&
      !p.split(/[\\/]/).some((s) => s === '..' || s === '.'),
    'Use an absolute native path without dot or parent segments',
  );
const rootSchema = z
  .object({
    path: nativePathSchema,
    host: z
      .string()
      .min(1)
      .max(255)
      .default(() => os.hostname()),
    runtime: runtimeSchema,
    projectId: idSchema.optional(),
  })
  .strict();
// The caller's AI review supplies semantic judgments; Core only checks structure.
// Discovery's candidate.type describes native layout, never a reviewed classification.
export const onboardingClassificationSchema = z
  .object({
    reviewer: z.string().trim().min(1).max(200),
    entries: z
      .array(
        z
          .object({
            sourceId: idSchema,
            status: z.enum(['classified', 'uncertain']),
            outputIds: z.array(idSchema).min(1).max(MAX_ASSETS),
            reason: z.string().trim().min(1).max(4000),
            unconvertedParts: z.array(z.string().trim().min(1).max(1000)).max(20),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_ASSETS),
  })
  .strict();
/** Reuse these schemas' .shape in MCP registrations; functions also validate direct callers. */
export const onboardingSchemas = {
  discover: z
    .object({
      id: idSchema.optional(),
      roots: z.array(rootSchema).max(32).optional(),
      includeDefaults: z.boolean().optional(),
      home: nativePathSchema.optional(),
    })
    .strict(),
  get: z.object({ id: idSchema }).strict(),
  list: z.object({}).strict(),
  import: z
    .object({ id: idSchema, assetIds: z.array(idSchema).min(1).max(MAX_ASSETS).optional() })
    .strict(),
  verify: z.object({ id: idSchema, userRequest: z.string().trim().min(1).max(4000) }).strict(),
  organize: z
    .object({
      id: idSchema,
      userRequest: z.string().trim().min(1).max(4000),
      reason: z.string().trim().min(1).max(4000),
      classification: onboardingClassificationSchema,
      operations: z.array(operationSchema).max(100),
    })
    .strict(),
  cutover: z.object({ id: idSchema }).strict(),
  restore: z.object({ id: idSchema, rollbackOrganization: z.boolean().default(true) }).strict(),
  plan: z.object({ id: idSchema, endpoint: z.string().url().optional() }).strict(),
  connect: z
    .object({
      id: idSchema,
      endpoint: z.string().url().optional(),
      userRequest: z.string().trim().min(1).max(4000),
    })
    .strict(),
  recordMcpRead: z.object({ assetId: idSchema, revision: z.number().int().positive() }).strict(),
};
const fileSchema = z
  .object({
    relative: z.string().min(1).max(4096),
    hash: hashSchema,
    bytes: z.number().int().min(0).max(MAX_FILE),
    mode: z.number().int().min(0).max(0o777),
    backedUp: z.boolean().default(false),
    removal: z.enum(['present', 'pending', 'removed', 'restored']).default('present'),
  })
  .strict();
const candidateSchema = z
  .object({
    id: idSchema,
    root: z.number().int().nonnegative(),
    path: nativePathSchema,
    entry: z.string(),
    type: z.enum(['skill', 'rule', 'other']),
    name: z.string().max(200),
    hash: hashSchema,
    files: z.array(fileSchema).max(MAX_FILES),
    imported: z.boolean().default(false),
    importChangeSetId: z.string().optional(),
    blocked: z.boolean().default(false),
  })
  .strict();
const stampSchema = z
  .object({ id: idSchema, revision: z.number().int().positive(), hash: hashSchema })
  .strict();
const manifestSchema = z
  .object({
    version: z.literal(1),
    id: idSchema,
    requestHash: hashSchema,
    host: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    phase: z.enum([
      'discovered',
      'importing',
      'imported',
      'verified',
      'organizing',
      'organized',
      'cutting-over',
      'cutover',
      'restoring',
      'restored',
    ]),
    // Optional for saved v1 manifests; reading legacy operations never migrates them.
    classificationRequired: z.literal(true).optional(),
    roots: z.array(rootSchema).max(32),
    candidates: z.array(candidateSchema).max(MAX_ASSETS),
    issues: z.array(z.object({ path: z.string(), code: z.string() }).strict()).max(MAX_SCAN + 32),
    selected: z.array(idSchema).max(MAX_ASSETS).optional(),
    reads: z.array(stampSchema).max(MAX_ASSETS).default([]),
    verification: z
      .object({ requestHash: hashSchema, changeSetId: z.string(), assets: z.array(stampSchema) })
      .strict()
      .optional(),
    organization: z
      .object({
        requestHash: hashSchema,
        changeSetId: z.string().optional(),
        assets: z.array(stampSchema),
        absent: z.array(idSchema).max(MAX_ASSETS).optional(),
        classification: onboardingClassificationSchema.optional(),
      })
      .strict()
      .optional(),
    pending: z
      .object({
        kind: z.enum(['verify', 'organize']),
        requestHash: hashSchema,
        marker: z.string(),
        assets: z.array(stampSchema),
        classification: onboardingClassificationSchema.optional(),
      })
      .strict()
      .optional(),
    rollbackChangeSetId: z.string().optional(),
    lastError: z.string().optional(),
    connection: connectionStateSchema.optional(),
  })
  .strict();
export type OnboardingManifest = z.infer<typeof manifestSchema>;
type Candidate = OnboardingManifest['candidates'][number];
type NativeFile = Candidate['files'][number];

function guard(ok: unknown, code: string, message: string): asserts ok {
  if (!ok) throw new DomainError(code, message, 409);
}
function errorCode(error: unknown) {
  return error instanceof DomainError ? error.code : 'ONBOARDING_IO';
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
function inside(root: string, target: string) {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}
// Check every ancestor, including ancestors outside a user-selected root. Do not follow links.
function safePath(file: string, allowMissing = false) {
  nativePathSchema.parse(file);
  const absolute = path.resolve(file);
  let current = path.parse(absolute).root;
  const parts = absolute.slice(current.length).split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    if (allowMissing && !exists(current)) return absolute;
    const stat = fs.lstatSync(current);
    guard(!stat.isSymbolicLink(), 'UNSAFE_PATH', 'Symbolic links are unsupported');
    if (i < parts.length - 1)
      guard(stat.isDirectory(), 'UNSAFE_PATH', 'A path ancestor is not a directory');
  }
  return absolute;
}
function safeRelative(value: string) {
  guard(
    value.length > 0 &&
      value.length <= 500 &&
      !/[\\:\x00-\x1f\x7f]/.test(value) &&
      !value.startsWith('/') &&
      value
        .split('/')
        .every(
          (s) =>
            s &&
            s !== '.' &&
            s !== '..' &&
            !/[. ]$/.test(s) &&
            !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s),
        ),
    'UNSAFE_PATH',
    'Unsafe bundle path',
  );
  return value;
}
function child(root: string, relative: string) {
  const target = path.join(root, ...safeRelative(relative).split('/'));
  guard(inside(root, target) && target !== root, 'UNSAFE_PATH', 'Path escapes its root');
  return target;
}
const managed = /^(plugins?|extensions?|marketplaces?)(?:[._-]|$)/i;
const excluded =
  /^(?:auth|credentials?|secrets?|tokens?|history|sessions?|projects|cache|caches|logs?|telemetry|state|config|settings|mcp|node_modules)(?:[._-]|$)/i;
const nativeContainers = [
  '.codex',
  '.claude',
  '.cursor',
  '.agents',
  '.vscode',
  '.windsurf',
  '.continue',
  '.kiro',
  '.gemini',
];
function exclusion(name: string): string | undefined {
  if (/^AACL-BOOTSTRAP(?:[.-]|$)/i.test(name)) return 'GENERATED_BOOTSTRAP';
  if (managed.test(name)) return 'PLUGIN_MANAGED_UNSUPPORTED';
  if (name.startsWith('.') && ![...nativeContainers, '.cursorrules'].includes(name))
    return 'EXCLUDED_PRIVATE';
  if (excluded.test(name) || /\.(?:pem|key|p12|pfx|sqlite|db|log)$/i.test(name))
    return 'EXCLUDED_PRIVATE';
}
function validateNative(file: string) {
  safePath(file, true);
  const parts = file.split(/[\\/]/);
  const nativeRoot = parts.findIndex((s) => nativeContainers.includes(s));
  // A workspace may itself live below a directory called projects/config. Exclude
  // sensitive ancestors inside native runtime roots, plus explicitly selected protected paths.
  const checked =
    nativeRoot >= 0
      ? parts.slice(nativeRoot + 1)
      : parts.filter(
          (s, index) =>
            index === parts.length - 1 || !['projects', 'config'].includes(s.toLowerCase()),
        );
  guard(
    !checked.some((s) => exclusion(s)) && !parts.some((s) => managed.test(s)),
    'EXCLUDED_PATH',
    'Private or plugin-managed paths are excluded',
  );
}
function readFile(file: string, max = MAX_FILE) {
  safePath(file);
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const before = fs.fstatSync(fd);
    guard(
      before.isFile() && before.nlink === 1,
      'UNSUPPORTED_FILE',
      'Only regular, unlinked files are supported',
    );
    guard(before.size <= max, 'FILE_TOO_LARGE', 'File exceeds the byte limit');
    const buffer = Buffer.alloc(Math.min(before.size + 1, max + 1));
    let length = 0;
    while (length < buffer.length) {
      const n = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!n) break;
      length += n;
    }
    const after = fs.fstatSync(fd);
    guard(
      length === before.size &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs,
      'SOURCE_CHANGED',
      'File changed while reading',
    );
    const bytes = buffer.subarray(0, length);
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new DomainError('UNSUPPORTED_ENCODING', 'Only UTF-8 assets are supported');
    }
    guard(!content.includes('\0'), 'UNSUPPORTED_ENCODING', 'Binary files are unsupported');
    return {
      content,
      hash: hash(bytes),
      bytes: length,
      mode: before.mode & 0o777,
      ino: before.ino,
      dev: before.dev,
    };
  } finally {
    fs.closeSync(fd);
  }
}
function mkdir(directory: string) {
  safePath(directory, true);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  safePath(directory);
}
function syncDirectory(directory: string) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function exclusiveWrite(file: string, content: string, mode = 0o600) {
  mkdir(path.dirname(file));
  safePath(file, true);
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
  syncDirectory(path.dirname(file));
}
function directory(core: Core, id?: string) {
  const root = path.join(safePath(core.store.root), 'onboarding');
  const target = id ? path.join(root, idSchema.parse(id)) : root;
  mkdir(target);
  return target;
}
function save(core: Core, manifest: OnboardingManifest) {
  manifest.updatedAt = now();
  manifestSchema.parse(manifest);
  const root = directory(core, manifest.id);
  const target = path.join(root, 'manifest.json');
  safePath(target, true);
  const temp = path.join(root, `manifest-${randomUUID()}.tmp`);
  exclusiveWrite(temp, JSON.stringify(manifest, null, 2) + '\n');
  fs.renameSync(temp, target);
  syncDirectory(root);
}
function load(core: Core, id: string) {
  const file = path.join(directory(core, id), 'manifest.json');
  guard(exists(file), 'NOT_FOUND', 'Onboarding operation not found');
  const manifest = manifestSchema.parse(JSON.parse(readFile(file, 8_000_000).content));
  guard(
    manifest.id === id && manifest.host === os.hostname(),
    'HOST_MISMATCH',
    'Operation belongs to another host',
  );
  for (const root of manifest.roots) {
    guard(root.host === os.hostname(), 'HOST_MISMATCH', 'A discovery root belongs to another host');
    guard(
      !inside(root.path, core.store.root) && !inside(core.store.root, root.path),
      'STORE_OVERLAP',
      'Discovery must not overlap the Core store',
    );
  }
  for (const c of manifest.candidates) {
    const root = manifest.roots[c.root];
    guard(
      root && root.host === os.hostname() && inside(root.path, c.path),
      'UNSAFE_PATH',
      'Candidate escapes discovery root',
    );
    validateNative(c.path);
    c.files.forEach((f) => child(c.path, f.relative));
    guard(
      c.files.some((f) => f.relative === c.entry),
      'INVALID_MANIFEST',
      'Candidate entry is missing',
    );
    guard(c.hash === bundleHash(c.files), 'INVALID_MANIFEST', 'Candidate hashes are inconsistent');
    const source = child(c.path, c.entry);
    const key = `${root.host}\0${source}\0${root.projectId ?? ''}`;
    guard(
      c.id === `native-${hash(key).slice(0, 32)}`,
      'INVALID_MANIFEST',
      'Candidate identity does not match its source',
    );
  }
  manifest.connection = nativeConnectionStatus(path.join(directory(core, id), 'connections'));
  return manifest;
}
function update<T>(core: Core, id: string, fn: (m: OnboardingManifest) => T): T {
  const manifest = load(core, id);
  try {
    delete manifest.lastError;
    const result = fn(manifest);
    save(core, manifest);
    return result;
  } catch (error) {
    manifest.lastError = errorCode(error);
    save(core, manifest);
    throw error;
  }
}
function bundleHash(files: Pick<NativeFile, 'relative' | 'hash'>[]) {
  return hash(
    JSON.stringify(files.map((f) => [f.relative, f.hash]).sort((a, b) => a[0].localeCompare(b[0]))),
  );
}
const stamp = (asset: Asset) => ({
  id: asset.id,
  revision: asset.revision,
  hash: hash(JSON.stringify(inputOf(asset))),
});
function selected(m: OnboardingManifest) {
  return m.candidates.filter((c) => m.selected?.includes(c.id));
}
// A README is documentation even when explicitly imported or packaged with a Skill.
// Derive this from the path so saved manifests from older releases are protected too.
function retainedDocument(file: Pick<NativeFile, 'relative'>) {
  return /^readme(?:[._-].*)?$/i.test(path.posix.basename(file.relative));
}
function importedAssets(core: Core, m: OnboardingManifest) {
  const assets = core.state().assets;
  return selected(m).map((c) => {
    const asset = assets.find((a) => a.id === c.id);
    guard(c.imported && asset, 'IMPORT_REQUIRED', 'Every selected asset must be imported');
    return asset;
  });
}
function checkOrganizationState(core: Core, m: OnboardingManifest, rollbackId?: string) {
  const organization = m.organization!;
  const expected = new Map(organization.assets.map((a) => [a.id, a]));
  const absent = new Set(organization.absent ?? []);
  if (rollbackId) {
    const rollback = core.state().state.changesets.find((cs) => cs.id === rollbackId);
    guard(
      rollback && rollback.rollbackOf === organization.changeSetId,
      'ROLLBACK_CONFLICT',
      'Organization rollback is missing',
    );
    for (const change of rollback.changes) {
      if (change.after) {
        expected.set(change.id, stamp(change.after));
        absent.delete(change.id);
      } else {
        expected.delete(change.id);
        absent.add(change.id);
      }
    }
  }
  const current = new Map(core.state().assets.map((a) => [a.id, a]));
  guard(
    [...expected.values()].every((s) => {
      const asset = current.get(s.id);
      return asset && asset.revision === s.revision && stamp(asset).hash === s.hash;
    }) && [...absent].every((id) => !current.has(id)),
    rollbackId ? 'ROLLBACK_CONFLICT' : 'ASSET_CHANGED',
    'Canonical outputs or retired originals changed after organization or rollback',
  );
}

/** Inherit provenance and existing scope constraints without interpreting source prose. */
function classificationOperations(
  core: Core,
  m: OnboardingManifest,
  req: z.infer<typeof onboardingSchemas.organize>,
) {
  const originals = importedAssets(core, m);
  const catalog = new Map(core.state().assets.map((a) => [a.id, a]));
  for (const original of originals) catalog.set(original.id, original);
  guard(
    originals.every((a) =>
      m.verification?.assets.some(
        (s) => s.id === a.id && s.revision === a.revision && s.hash === stamp(a).hash,
      ),
    ),
    'ASSET_CHANGED',
    'Imported assets changed after MCP verification; review the current source revisions',
  );
  const entries = req.classification.entries;
  const sourceIds = new Set(originals.map((a) => a.id));
  guard(
    entries.length === sourceIds.size &&
      new Set(entries.map((e) => e.sourceId)).size === entries.length &&
      entries.every(
        (e) => sourceIds.has(e.sourceId) && new Set(e.outputIds).size === e.outputIds.length,
      ),
    'CLASSIFICATION_COVERAGE',
    'The AI review must cover every selected source exactly once, with distinct output IDs',
  );
  const outputs = new Map<string, Asset[]>();
  for (const entry of entries) {
    guard(
      entry.status !== 'uncertain' ||
        (entry.outputIds.length === 1 && entry.outputIds[0] === entry.sourceId),
      'UNCERTAIN_CLASSIFICATION',
      'Uncertain sources must retain their original ID as a disabled provisional asset',
    );
    for (const id of entry.outputIds) {
      guard(
        !sourceIds.has(id) || id === entry.sourceId,
        'CLASSIFICATION_CONFLICT',
        'An output cannot consume a different selected source ID',
      );
      outputs.set(id, [
        ...(outputs.get(id) ?? []),
        originals.find((a) => a.id === entry.sourceId)!,
      ]);
    }
  }
  guard(
    outputs.size <= MAX_ASSETS,
    'CLASSIFICATION_LIMIT',
    'A classification may produce at most 100 outputs',
  );
  const operations = req.operations.map((op) => {
    const id = op.op === 'upsert' ? op.asset.id : op.id;
    guard(
      sourceIds.has(id) || outputs.has(id),
      'CLASSIFICATION_COVERAGE',
      'Every operation must affect a selected source or a declared output',
    );
    if (op.op === 'delete') {
      guard(
        sourceIds.has(id) && !outputs.has(id),
        'CLASSIFICATION_CONFLICT',
        'Only replaced originals may be deleted',
      );
      return op;
    }
    const sources = outputs.get(id);
    if (!sources) return op;
    const asset = structuredClone(op.asset);
    for (const source of sources) {
      for (const [key, values] of Object.entries(source.scope)) {
        const dimension = key as keyof typeof source.scope;
        const supplied = asset.scope[dimension];
        guard(
          !supplied || JSON.stringify([...supplied].sort()) === JSON.stringify([...values!].sort()),
          'SOURCE_SCOPE_CHANGED',
          'Converted outputs must preserve every source scope constraint',
        );
        asset.scope[dimension] = values;
      }
      guard(
        !source.projectId || !asset.projectId || source.projectId === asset.projectId,
        'SOURCE_SCOPE_CHANGED',
        'Converted outputs must preserve their source project',
      );
      asset.projectId ??= source.projectId;
      const provenance = new Map((asset.sources ?? []).map((s) => [JSON.stringify(s), s]));
      for (const origin of source.sources ?? []) provenance.set(JSON.stringify(origin), origin);
      asset.sources = [...provenance.values()];
    }
    return { ...op, asset };
  });
  // Even retained or reused outputs participate in the revision-checked transaction.
  // Otherwise another writer could change them between validation and the commit.
  const tracked = new Set([...sourceIds, ...outputs.keys()]);
  const operated = new Set(operations.map((op) => (op.op === 'upsert' ? op.asset.id : op.id)));
  for (const id of tracked) {
    const asset = catalog.get(id);
    if (!operated.has(id) && asset)
      operations.push({ op: 'upsert', asset: inputOf(asset), expectedRevision: asset.revision });
  }
  guard(
    operations.length <= MAX_ASSETS,
    'CLASSIFICATION_LIMIT',
    'The complete atomic batch, including retained originals and reused outputs, may affect at most 100 assets',
  );
  const preview = core.validateChanges({ operations, summary: req.reason });
  const after = new Map(catalog);
  for (const change of preview.changes) {
    if (change.after) after.set(change.id, change.after);
    else after.delete(change.id);
  }
  for (const entry of entries) {
    const original = originals.find((a) => a.id === entry.sourceId)!;
    guard(
      !m.classificationRequired || !original.enabled,
      'PROVISIONAL_ASSET_REQUIRED',
      'Disable the provisional original before reviewed conversion',
    );
    const retained = after.get(original.id);
    guard(
      entry.outputIds.every((id) => after.has(id)),
      'CLASSIFICATION_CONFLICT',
      'Every reviewed output must exist after the organization batch',
    );
    if (!entry.outputIds.includes(original.id)) {
      guard(
        !retained?.enabled,
        'ORIGINAL_STILL_ACTIVE',
        'Delete or disable replaced originals in the same batch',
      );
      guard(
        !retained || stamp(retained).hash === stamp(original).hash,
        'ORIGINAL_CHANGED',
        'A retained provisional original must preserve its content, files, provenance and scopes',
      );
    }
    if (entry.status === 'uncertain')
      guard(
        retained && !retained.enabled && stamp(retained).hash === stamp(original).hash,
        'UNCERTAIN_CLASSIFICATION',
        'Uncertain sources must remain unchanged and disabled',
      );
    if (
      retained?.enabled &&
      entry.outputIds.some(
        (id) => id !== original.id && after.get(id)?.enabled && after.get(id)?.type === 'workflow',
      )
    )
      guard(
        retained.content !== original.content,
        'ORIGINAL_STILL_ACTIVE',
        'Do not enable original orchestration text alongside its converted Workflow',
      );
  }
  // Also validate outputs that were reused without an upsert: inheritance cannot be skipped.
  for (const [id, sources] of outputs) {
    const asset = after.get(id)!;
    for (const source of sources) {
      guard(
        Object.entries(source.scope).every(
          ([key, values]) =>
            JSON.stringify([...(asset.scope[key as keyof typeof asset.scope] ?? [])].sort()) ===
            JSON.stringify([...values!].sort()),
        ) &&
          (!source.projectId || asset.projectId === source.projectId),
        'SOURCE_SCOPE_CHANGED',
        'Reused outputs must retain their source scopes',
      );
      guard(
        (source.sources ?? []).every((s) =>
          asset.sources?.some((a) => a.host === s.host && a.path === s.path && a.hash === s.hash),
        ),
        'SOURCE_PROVENANCE_REQUIRED',
        'Every converted output must retain its original source provenance',
      );
    }
  }
  return { operations, baseline: [...catalog.values()].filter((a) => tracked.has(a.id)) };
}
function backupPath(core: Core, m: OnboardingManifest, c: Candidate, f: NativeFile) {
  return child(path.join(directory(core, m.id), 'backup', c.id), f.relative);
}
function checkedSource(c: Candidate, f: NativeFile) {
  const file = child(c.path, f.relative);
  validateNative(file);
  const data = readFile(file);
  guard(
    data.hash === f.hash && data.bytes === f.bytes,
    'SOURCE_CHANGED',
    'A discovered source file changed; rediscover before importing or cutting over',
  );
  return data;
}
function checkedBackup(core: Core, m: OnboardingManifest, c: Candidate, f: NativeFile) {
  const data = readFile(backupPath(core, m, c, f));
  guard(
    data.hash === f.hash && data.bytes === f.bytes,
    'BACKUP_CHANGED',
    'Backup hash does not match the discovery manifest',
  );
  return data;
}
function checkSkillMembers(c: Candidate) {
  if (c.type !== 'skill') return;
  const expected = new Set(c.files.map((f) => f.relative));
  let count = 0;
  const walk = (root: string, prefix = '', depth = 0) => {
    guard(depth <= 20, 'SOURCE_CHANGED', 'New directories appeared inside the skill');
    for (const entry of fs.readdirSync(safePath(root), { withFileTypes: true })) {
      guard(++count <= MAX_SCAN, 'SOURCE_CHANGED', 'New files appeared inside the skill');
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const file = path.join(root, entry.name);
      safePath(file);
      guard(!exclusion(entry.name), 'SOURCE_CHANGED', 'Excluded files appeared inside the skill');
      if (entry.isDirectory()) walk(file, relative, depth + 1);
      else
        guard(
          expected.has(relative),
          'SOURCE_CHANGED',
          'New files appeared inside the skill; rediscover before cutover',
        );
    }
  };
  walk(c.path);
}
function ensureActive(m: OnboardingManifest) {
  guard(
    !['restoring', 'restored', 'cutting-over', 'cutover'].includes(m.phase),
    'ONBOARDING_PHASE',
    'This operation is no longer editable',
  );
}
function recoverPending(core: Core, m: OnboardingManifest) {
  const pending = m.pending;
  if (!pending) return false;
  const change = core
    .state()
    .state.changesets.find((cs) => cs.summary.startsWith(pending.marker + '\n'));
  if (!change) return false;
  const assets = pending.assets.flatMap((before) => {
    const changed = change.changes.find((c) => c.id === before.id);
    guard(
      !changed || changed.after || pending.classification,
      'IMPORTED_ASSET_REQUIRED',
      'A pending operation removed an imported asset',
    );
    return changed ? (changed.after ? [stamp(changed.after)] : []) : [before];
  });
  if (pending.classification)
    for (const item of change.changes)
      if (item.after && !assets.some((a) => a.id === item.id)) assets.push(stamp(item.after));
  if (pending.kind === 'verify') {
    m.verification = { requestHash: pending.requestHash, changeSetId: change.id, assets };
    m.phase = 'verified';
  } else {
    m.organization = {
      requestHash: pending.requestHash,
      changeSetId: change.id,
      assets,
      ...(pending.classification
        ? {
            classification: pending.classification,
            absent: change.changes.filter((c) => !c.after).map((c) => c.id),
          }
        : {}),
    };
    m.phase = 'organized';
  }
  delete m.pending;
  return true;
}

/** Persist a bounded discovery. Explicit roots replace defaults unless includeDefaults=true. */
export function onboardingDiscover(core: Core, input: unknown) {
  const req = onboardingSchemas.discover.parse(input);
  let roots = req.roots ?? [];
  if (req.includeDefaults ?? req.roots === undefined) {
    const home = req.home ?? os.homedir();
    roots = [
      ...roots,
      ...(['codex', 'claude', 'cursor'] as const).map((runtime) => ({
        path: path.join(home, `.${runtime}`),
        host: os.hostname(),
        runtime,
      })),
      { path: path.join(home, '.agents'), host: os.hostname(), runtime: 'codex' as const },
    ];
  }
  roots = roots.map((r) => ({ ...r, path: path.resolve(r.path) }));
  guard(
    roots.length > 0 && roots.length <= 32,
    'ROOTS_REQUIRED',
    'Specify between one and 32 discovery roots',
  );
  for (const root of roots) {
    guard(root.host === os.hostname(), 'HOST_MISMATCH', 'Discovery only accesses the local host');
    guard(
      !inside(root.path, core.store.root) && !inside(core.store.root, root.path),
      'STORE_OVERLAP',
      'Discovery must not overlap the Core store',
    );
    if (root.projectId)
      guard(
        core.state().state.projects.some((p) => p.id === root.projectId),
        'PROJECT_NOT_FOUND',
        'Project is not registered',
      );
  }
  const requestHash = hash(JSON.stringify(roots));
  const id = req.id ?? `onboarding-${requestHash.slice(0, 24)}`;
  if (exists(path.join(directory(core, id), 'manifest.json'))) {
    const previous = load(core, id);
    guard(
      previous.requestHash === requestHash,
      'IDEMPOTENCY_CONFLICT',
      'Operation ID is already used for different roots',
    );
    return previous;
  }
  const m: OnboardingManifest = {
    version: 1,
    id,
    requestHash,
    host: os.hostname(),
    createdAt: now(),
    updatedAt: now(),
    phase: 'discovered',
    classificationRequired: true,
    roots,
    candidates: [],
    issues: [],
    reads: [],
  };
  let scanned = 0;
  let total = 0;
  const seen = new Set<string>();
  const issue = (file: string, code: string) => {
    if (m.issues.length < MAX_SCAN) m.issues.push({ path: file, code });
  };
  const tick = () =>
    guard(
      ++scanned <= MAX_SCAN,
      'DISCOVERY_LIMIT',
      'Discovery entry limit reached; select narrower roots',
    );
  function collect(
    root: string,
    relative = '',
    depth = 0,
  ): { files: NativeFile[]; blocked: boolean } {
    guard(depth <= 20, 'DISCOVERY_LIMIT', 'Directory depth limit reached');
    const files: NativeFile[] = [];
    let blocked = false;
    for (const entry of fs
      .readdirSync(root, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      tick();
      const file = path.join(root, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const excludedCode = exclusion(entry.name);
      if (excludedCode) {
        issue(file, excludedCode);
        blocked = true;
        continue;
      }
      try {
        safeRelative(rel);
        safePath(file);
        if (entry.isDirectory()) {
          const nested = collect(file, rel, depth + 1);
          files.push(...nested.files);
          blocked ||= nested.blocked;
        } else {
          const data = readFile(file);
          total += data.bytes;
          guard(total <= MAX_TOTAL, 'DISCOVERY_LIMIT', 'Discovery byte limit reached');
          files.push({
            relative: rel,
            hash: data.hash,
            bytes: data.bytes,
            mode: data.mode,
            backedUp: false,
            removal: 'present',
          });
        }
        guard(
          files.length <= MAX_FILES && files.reduce((n, f) => n + f.bytes, 0) <= MAX_BUNDLE,
          'BUNDLE_LIMIT',
          'Skill bundle exceeds the file or byte limit',
        );
      } catch (error) {
        if (errorCode(error) === 'DISCOVERY_LIMIT') throw error;
        issue(file, errorCode(error));
        blocked = true;
      }
    }
    return { files: files.slice(0, MAX_FILES), blocked };
  }
  function add(rootIndex: number, location: string, entry: string, type: Candidate['type']) {
    const source = path.join(location, entry);
    const key = `${roots[rootIndex].host}\0${source}\0${roots[rootIndex].projectId ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    guard(
      m.candidates.length < MAX_ASSETS,
      'DISCOVERY_LIMIT',
      'Discovery asset limit reached; select narrower roots',
    );
    let files: NativeFile[];
    let blocked = false;
    if (type === 'skill') ({ files, blocked } = collect(location));
    else {
      const data = readFile(source);
      total += data.bytes;
      guard(total <= MAX_TOTAL, 'DISCOVERY_LIMIT', 'Discovery byte limit reached');
      files = [
        {
          relative: entry,
          hash: data.hash,
          bytes: data.bytes,
          mode: data.mode,
          backedUp: false,
          removal: 'present',
        },
      ];
    }
    if (!files.some((f) => f.relative === entry)) {
      issue(source, 'UNSUPPORTED_ENTRY');
      return;
    }
    const name = (
      type === 'skill' ? path.basename(location) : path.basename(entry, path.extname(entry))
    ).slice(0, 200);
    m.candidates.push({
      id: `native-${hash(key).slice(0, 32)}`,
      root: rootIndex,
      path: location,
      entry,
      type,
      name,
      hash: bundleHash(files),
      files,
      imported: false,
      blocked,
    });
  }
  function walk(rootIndex: number, directory: string, depth = 0) {
    guard(depth <= 20, 'DISCOVERY_LIMIT', 'Directory depth limit reached');
    safePath(directory);
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    if (entries.some((e) => e.name === 'SKILL.md')) {
      add(rootIndex, directory, 'SKILL.md', 'skill');
      return;
    }
    for (const entry of entries) {
      tick();
      const file = path.join(directory, entry.name);
      const code = exclusion(entry.name);
      if (code) {
        issue(file, code);
        continue;
      }
      try {
        safePath(file);
        if (entry.isDirectory()) walk(rootIndex, file, depth + 1);
        else if (
          /\.(?:md|mdc|rules|txt|prompt)$/i.test(entry.name) ||
          entry.name === '.cursorrules'
        ) {
          const rule =
            /^(?:AGENTS|CLAUDE|GEMINI)(?:\.local)?\.md$/i.test(entry.name) ||
            /^AGENTS\.override\.md$/i.test(entry.name) ||
            /(?:^|[\\/])rules(?:[\\/]|$)/i.test(file) ||
            /\.(?:rules|mdc)$/.test(entry.name) ||
            entry.name === '.cursorrules';
          const instruction =
            rule ||
            /(?:^|[\\/])(?:prompts|commands)(?:[\\/]|$)/i.test(file) ||
            /\.prompt$/i.test(entry.name);
          if (instruction && !retainedDocument({ relative: entry.name }))
            add(rootIndex, directory, entry.name, rule ? 'rule' : 'other');
        } else issue(file, 'UNSUPPORTED_ASSET');
      } catch (error) {
        if (errorCode(error) === 'DISCOVERY_LIMIT') throw error;
        issue(file, errorCode(error));
      }
    }
  }
  roots.forEach((root, index) => {
    try {
      validateNative(root.path);
      if (!exists(root.path)) {
        issue(root.path, 'ROOT_MISSING');
        return;
      }
      if (fs.lstatSync(root.path).isDirectory()) walk(index, root.path);
      else {
        // Explicit file roots are represented by their parent so bundle paths remain relative.
        guard(
          /\.(?:md|mdc|rules|txt|prompt)$/i.test(root.path) ||
            path.basename(root.path) === '.cursorrules',
          'UNSUPPORTED_ASSET',
          'Unsupported explicit asset',
        );
        const source = root.path;
        root.path = path.dirname(source);
        if (path.basename(source) === 'SKILL.md') add(index, root.path, 'SKILL.md', 'skill');
        else
          add(
            index,
            root.path,
            path.basename(source),
            /(?:AGENTS(?:\.override)?|CLAUDE)\.md$|\.(?:rules|mdc)$/.test(source)
              ? 'rule'
              : 'other',
          );
      }
    } catch (error) {
      issue(root.path, errorCode(error));
    }
  });
  save(core, m);
  return m;
}

export function onboardingGet(core: Core, input: unknown) {
  const req = onboardingSchemas.get.parse(input);
  return load(core, req.id);
}
export function onboardingList(core: Core, input: unknown = {}) {
  onboardingSchemas.list.parse(input);
  return fs
    .readdirSync(directory(core))
    .filter(
      (id) =>
        idSchema.safeParse(id).success && exists(path.join(directory(core), id, 'manifest.json')),
    )
    .map((id) => {
      const m = load(core, id);
      return {
        id,
        phase: m.phase,
        host: m.host,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        candidates: m.candidates.length,
        imported: m.candidates.filter((c) => c.imported).length,
        lastError: m.lastError,
      };
    });
}

/** Copy all selected sources first. Import only verified backup bytes, through Core. */
export function onboardingImport(core: Core, input: unknown) {
  const req = onboardingSchemas.import.parse(input);
  return update(core, req.id, (m) => {
    const ids = [
      ...new Set(
        req.assetIds ?? m.selected ?? m.candidates.filter((c) => !c.blocked).map((c) => c.id),
      ),
    ].sort();
    guard(
      ids.length > 0 && ids.every((id) => m.candidates.some((c) => c.id === id && !c.blocked)),
      'UNSUPPORTED_SELECTION',
      'Select supported discovered assets',
    );
    guard(
      !m.selected || JSON.stringify(m.selected) === JSON.stringify(ids),
      'IDEMPOTENCY_CONFLICT',
      'This operation already has a different import selection',
    );
    if (m.selected && selected(m).every((c) => c.imported)) return m;
    ensureActive(m);
    m.selected = ids;
    m.phase = 'importing';
    save(core, m);
    for (const c of selected(m)) checkSkillMembers(c);
    for (const c of selected(m))
      for (const f of c.files) {
        const source = checkedSource(c, f);
        const target = backupPath(core, m, c, f);
        if (!exists(target)) exclusiveWrite(target, source.content);
        checkedBackup(core, m, c, f);
        f.backedUp = true;
        save(core, m);
      }
    const prepared = selected(m)
      .filter((c) => !c.imported)
      .map((c) => {
        const contents = Object.fromEntries(
          c.files.map((f) => [f.relative, checkedBackup(core, m, c, f).content]),
        );
        const root = m.roots[c.root];
        const sourcePath = child(c.path, c.entry);
        const asset = assetSchema.parse({
          id: c.id,
          type: m.classificationRequired ? 'other' : c.type,
          name: c.name,
          content: contents[c.entry],
          files: Object.fromEntries(Object.entries(contents).filter(([name]) => name !== c.entry)),
          sources: [{ host: root.host, path: sourcePath, hash: c.hash }],
          scope: {
            runtime: [root.runtime],
            ...(root.projectId ? { project: [root.projectId] } : {}),
          },
          projectId: root.projectId,
          enabled: false,
          activation: 'on-demand',
        });
        return { c, root, sourcePath, asset };
      });
    const marker = `onboarding:${m.id}:import:${hash(JSON.stringify(selected(m).map((c) => [c.id, c.hash])))}`;
    const { assets, state } = core.state();
    const previous = state.changesets.find((cs) => cs.summary === marker);
    const operations: {
      op: 'upsert';
      asset: z.infer<typeof assetSchema>;
      expectedRevision: number;
    }[] = [];
    for (const { c, root, sourcePath, asset } of prepared) {
      const existing = assets.find((a) => a.id === c.id);
      if (existing) {
        guard(
          existing.sources?.some(
            (s) => s.host === root.host && s.path === sourcePath && s.hash === c.hash,
          ) &&
            existing.content === asset.content &&
            JSON.stringify(existing.files) === JSON.stringify(asset.files) &&
            (!m.classificationRequired || !existing.enabled),
          'ASSET_CONFLICT',
          'A canonical asset with this source ID already differs',
        );
        c.importChangeSetId =
          previous?.id ??
          state.changesets.find((cs) =>
            cs.changes.some((change) => change.id === c.id && !change.before && change.after),
          )?.id;
      } else {
        guard(!previous, 'ASSET_CONFLICT', 'An earlier imported asset was subsequently removed');
        operations.push({ op: 'upsert', asset, expectedRevision: 0 });
      }
    }
    // Core sees the whole imported catalog at once, so its standard relation extraction
    // can resolve forward references without a second content edit or a separate extractor.
    const change = operations.length
      ? core.changeAssets({ operations, origin: 'native-import', summary: marker })
      : previous;
    for (const { c } of prepared) {
      c.importChangeSetId ??= change?.id;
      c.imported = true;
      save(core, m);
    }
    m.phase = 'imported';
    return m;
  });
}

/** Trusted integration hook: call only after a successful MCP asset_get response is constructed.
 * Do not register this hook as a public tool or HTTP route. */
export function onboardingRecordMcpRead(core: Core, input: unknown) {
  const { assetId, revision } = onboardingSchemas.recordMcpRead.parse(input);
  const asset = core.state().assets.find((a) => a.id === assetId);
  guard(asset, 'NOT_FOUND', 'Retrieved asset no longer exists');
  guard(
    asset.revision === revision,
    'STALE_MCP_READ',
    'The retrieved revision is no longer current',
  );
  for (const item of onboardingList(core)) {
    if (['restoring', 'restored', 'cutover', 'cutting-over'].includes(item.phase)) continue;
    update(core, item.id, (m) => {
      if (!m.candidates.some((c) => c.id === assetId && c.imported && m.selected?.includes(c.id)))
        return;
      m.reads = [...m.reads.filter((r) => r.id !== assetId), stamp(asset)];
    });
  }
}

/** The third argument is server-supplied transport provenance, never user input.
 * This makes a real revisioned Core write after every selected asset was retrieved over MCP. */
export function onboardingVerify(core: Core, input: unknown, transport?: 'mcp') {
  const req = onboardingSchemas.verify.parse(input);
  guard(
    transport === 'mcp',
    'MCP_REQUIRED',
    'Verification must be invoked through the MCP handler',
  );
  return update(core, req.id, (m) => {
    recoverPending(core, m);
    if (m.verification) return m;
    ensureActive(m);
    const assets = importedAssets(core, m);
    guard(assets.length > 0, 'IMPORT_REQUIRED', 'Import assets before verification');
    const requestHash = hash(JSON.stringify(req));
    const marker = `onboarding:${m.id}:verify:${requestHash}`;
    const prior = core.state().state.changesets.find((cs) => cs.summary.startsWith(marker + '\n'));
    if (!prior) {
      guard(
        assets.every((a) =>
          m.reads.some(
            (r) => r.id === a.id && r.revision === a.revision && r.hash === stamp(a).hash,
          ),
        ),
        'MCP_READ_REQUIRED',
        'Retrieve every imported asset at its current revision through MCP first',
      );
      guard(
        !m.pending || (m.pending.kind === 'verify' && m.pending.requestHash === requestHash),
        'PENDING_OPERATION',
        'Resume the pending request first',
      );
      m.pending = { kind: 'verify', requestHash, marker, assets: assets.map(stamp) };
      save(core, m);
    }
    const change =
      prior ??
      core.changeAssets({
        summary: `${marker}\nMCP retrieval/write verification requested by user: ${req.userRequest}`,
        operations: assets.map((a) => ({
          op: 'upsert',
          asset: inputOf(a),
          expectedRevision: a.revision,
        })),
      });
    m.verification = {
      requestHash,
      changeSetId: change.id,
      assets: importedAssets(core, m).map(stamp),
    };
    delete m.pending;
    m.phase = 'verified';
    return m;
  });
}

export function onboardingOrganize(core: Core, input: unknown) {
  const req = onboardingSchemas.organize.parse(input);
  return update(core, req.id, (m) => {
    recoverPending(core, m);
    const requestHash = hash(JSON.stringify(req));
    if (m.organization) {
      guard(
        m.organization.requestHash === requestHash,
        'IDEMPOTENCY_CONFLICT',
        'This operation already contains another organization batch',
      );
      return m;
    }
    ensureActive(m);
    guard(m.verification, 'MCP_REQUIRED', 'Verify MCP retrieval and write before organization');
    const marker = `onboarding:${m.id}:organize:${requestHash}`;
    guard(
      !m.pending || (m.pending.kind === 'organize' && m.pending.requestHash === requestHash),
      'PENDING_OPERATION',
      'Resume the pending organization request',
    );
    const { operations, baseline } = classificationOperations(core, m, req);
    m.pending = {
      kind: 'organize',
      requestHash,
      marker,
      assets: baseline.map(stamp),
      classification: req.classification,
    };
    m.phase = 'organizing';
    save(core, m);
    core.changeAssets({
      operations,
      summary: `${marker}\nUser request: ${req.userRequest}\nOrganization reason: ${req.reason}`,
    });
    // Read the committed snapshots, never absorb a later edit into the cutover proof.
    guard(
      recoverPending(core, m),
      'ORGANIZATION_COMMIT_MISSING',
      'The organization changeset is missing',
    );
    return m;
  });
}

/** Remove only backed-up imported files. Every candidate is preflighted before the first removal. */
export function onboardingCutover(core: Core, input: unknown) {
  const req = onboardingSchemas.cutover.parse(input);
  return update(core, req.id, (m) => {
    if (m.phase === 'cutover') return m;
    recoverPending(core, m);
    guard(
      ['organized', 'cutting-over'].includes(m.phase) && m.organization && m.verification,
      'CUTOVER_NOT_READY',
      'MCP verification and organization are required',
    );
    guard(
      selected(m).every((c) => m.roots[c.root].runtime !== 'other'),
      'UNSUPPORTED_CUTOVER',
      'Other runtimes need an explicit native loading adapter before cutover',
    );
    guard(
      (!m.classificationRequired || m.organization.classification) &&
        (!m.organization.classification ||
          m.organization.classification.entries.every(
            (e) => e.status === 'classified' && !e.unconvertedParts.length,
          )),
      'CLASSIFICATION_INCOMPLETE',
      'Resolve every uncertain classification and unconverted part before cutover',
    );
    checkOrganizationState(core, m);
    for (const c of selected(m)) checkSkillMembers(c);
    for (const c of selected(m))
      for (const f of c.files) {
        if (retainedDocument(f)) continue;
        guard(f.backedUp, 'BACKUP_REQUIRED', 'All imported files require verified backups');
        checkedBackup(core, m, c, f);
        const source = child(c.path, f.relative);
        if (exists(source)) {
          guard(
            f.removal !== 'removed',
            'SOURCE_REAPPEARED',
            'A removed native source was recreated',
          );
          checkedSource(c, f);
        } else
          guard(
            ['pending', 'removed'].includes(f.removal),
            'SOURCE_MISSING',
            'Native source disappeared before cutover',
          );
      }
    m.phase = 'cutting-over';
    save(core, m);
    // Remove entry points first; a interrupted cutover cannot leave a skill with missing helpers.
    for (const c of selected(m))
      for (const f of [...c.files].sort(
        (a, b) => Number(b.relative === c.entry) - Number(a.relative === c.entry),
      )) {
        if (retainedDocument(f)) continue;
        if (f.removal === 'removed') continue;
        const source = child(c.path, f.relative);
        if (exists(source)) {
          const before = checkedSource(c, f);
          f.removal = 'pending';
          save(core, m);
          safePath(source);
          const stat = fs.lstatSync(source);
          guard(
            stat.ino === before.ino && stat.dev === before.dev && readFile(source).hash === f.hash,
            'SOURCE_CHANGED',
            'Source changed before removal',
          );
          fs.unlinkSync(source);
          syncDirectory(path.dirname(source));
        }
        f.removal = 'removed';
        save(core, m);
      }
    m.phase = 'cutover';
    return m;
  });
}

function checkConnectionDependents(core: Core, manifest: OnboardingManifest) {
  const changed = new Set(
    manifest.connection?.files.filter((file) => file.changed).map((file) => file.path),
  );
  if (!changed.size) return;
  // Identical bytes do not imply exclusive ownership: a later operation may have
  // reused this connection before removing its own native skill entry points.
  for (const id of fs.readdirSync(directory(core))) {
    if (id === manifest.id || !idSchema.safeParse(id).success) continue;
    const connection = nativeConnectionStatus(path.join(directory(core, id), 'connections'));
    if (!connection || connection.phase === 'restored') continue;
    guard(
      !connection.files.some((file) => changed.has(file.path)),
      'CONNECTION_IN_USE',
      `Restore dependent onboarding operation ${id} before removing its shared connection`,
    );
  }
}

/** Restore only absent native files; never overwrite subsequent user edits.
 * Organization rollback uses Core history and its revision conflict checks. */
export function onboardingRestore(core: Core, input: unknown) {
  const req = onboardingSchemas.restore.parse(input);
  return update(core, req.id, (m) => {
    if (m.phase === 'restored') return m;
    recoverPending(core, m);
    guard(
      m.selected || m.connection,
      'IMPORT_REQUIRED',
      'There is no import or connection to restore',
    );
    guard(
      !m.organization?.classification || req.rollbackOrganization,
      'ORGANIZATION_ROLLBACK_REQUIRED',
      'Restore must reverse reviewed conversion before restoring native entry points',
    );
    const priorRollback =
      m.rollbackChangeSetId ??
      core
        .state()
        .state.changesets.find(
          (cs) => cs.rollbackOf === m.organization?.changeSetId && !!m.organization?.changeSetId,
        )?.id;
    if (m.organization?.classification) checkOrganizationState(core, m, priorRollback);
    checkConnectionDependents(core, m);
    preflightNativeConnectionRestore(path.join(directory(core, m.id), 'connections'));
    for (const c of selected(m))
      for (const f of c.files) {
        if (retainedDocument(f) && f.removal === 'present') continue;
        if (!f.backedUp) continue;
        checkedBackup(core, m, c, f);
        const source = child(c.path, f.relative);
        if (exists(source)) checkedSource(c, f);
        else
          guard(
            ['pending', 'removed'].includes(f.removal),
            'SOURCE_MISSING',
            'Source was removed outside this operation',
          );
      }
    m.phase = 'restoring';
    save(core, m);
    if (req.rollbackOrganization && m.organization?.changeSetId && !m.rollbackChangeSetId) {
      const originalId = m.organization.changeSetId;
      const previous = core.state().state.changesets.find((cs) => cs.rollbackOf === originalId);
      if (previous) {
        const current = core.state().assets;
        guard(
          previous.changes.every((c) => {
            const a = current.find((a) => a.id === c.id);
            return c.after
              ? a && a.revision === c.after.revision && stamp(a).hash === stamp(c.after).hash
              : !a;
          }),
          'ROLLBACK_CONFLICT',
          'Assets changed after the previous organization rollback',
        );
      }
      m.rollbackChangeSetId = (previous ?? core.rollback({ changeSetId: originalId })).id;
      save(core, m);
    }
    // Restore helpers before entry points so interrupted restores do not activate incomplete skills.
    for (const c of selected(m))
      for (const f of [...c.files].sort(
        (a, b) => Number(a.relative === c.entry) - Number(b.relative === c.entry),
      )) {
        if (retainedDocument(f) && f.removal === 'present') continue;
        if (!f.backedUp) continue;
        const source = child(c.path, f.relative);
        validateNative(source);
        if (!exists(source)) exclusiveWrite(source, checkedBackup(core, m, c, f).content, f.mode);
        checkedSource(c, f);
        f.removal = 'restored';
        save(core, m);
      }
    m.connection = restoreNativeConnections(path.join(directory(core, m.id), 'connections'));
    delete m.pending;
    m.phase = 'restored';
    return m;
  });
}

export function onboardingPlan(core: Core, input: unknown) {
  const req = onboardingSchemas.plan.parse(input);
  const m = load(core, req.id);
  return {
    id: m.id,
    phase: m.phase,
    plans: m.roots.map((root, index) => ({
      root,
      ...onboardingConnectionPlan({ runtime: root.runtime, endpoint: req.endpoint }),
      cutover: {
        supported: root.runtime !== 'other',
        method: 'remove-only-imported-files-after-mcp-verification',
        paths: selected(m)
          .filter((c) => c.root === index)
          .flatMap((c) =>
            c.files.filter((f) => !retainedDocument(f)).map((f) => child(c.path, f.relative)),
          ),
        retainedPaths: selected(m)
          .filter((c) => c.root === index)
          .flatMap((c) => c.files.filter(retainedDocument).map((f) => child(c.path, f.relative))),
        prerequisites: [
          'verified-backups',
          'actual-mcp-retrieval-and-write',
          'user-requested-organization',
          'reviewed-classification-with-no-unconverted-parts',
          'unchanged-native-and-canonical-hashes',
        ],
        unsupported: m.issues.filter((i) => inside(root.path, i.path)),
      },
    })),
  };
}

/** Optional for already connected runtimes. This installs a connection but never
 * manufactures MCP read/write proof. Bootstrap paths are durably registered in status. */
export function onboardingConnect(core: Core, input: unknown) {
  const req = onboardingSchemas.connect.parse(input);
  return update(core, req.id, (m) => {
    ensureActive(m);
    const endpoint = onboardingConnectionPlan({
      runtime: 'codex',
      endpoint: req.endpoint,
    }).endpoint;
    const projects = core.state().state.projects;
    // Retry the saved target set even when installing created a previously absent
    // runtime directory, or discovery roots have since appeared/disappeared.
    const targets =
      m.connection?.targets ??
      m.roots
        .filter((r) => r.runtime !== 'other' && (r.projectId || exists(r.path)))
        .map((root) => {
          const project = root.projectId
            ? projects.find((p) => p.id === root.projectId)
            : undefined;
          guard(
            !root.projectId || project,
            'PROJECT_NOT_FOUND',
            'Connection project no longer exists',
          );
          return nativeConnectionTarget(root, project?.root);
        });
    const unique = [...new Map(targets.map((target) => [target.configPath, target])).values()];
    const targetPaths = new Set(
      unique.flatMap((target) => [target.configPath, target.bootstrapPath]),
    );
    // Finish or undo a pending owner before another operation can share its files.
    // Otherwise two interrupted preparations can each claim the other's restore.
    for (const id of fs.readdirSync(directory(core))) {
      if (id === m.id || !idSchema.safeParse(id).success) continue;
      const connection = nativeConnectionStatus(path.join(directory(core, id), 'connections'));
      guard(
        !connection ||
          ['installed', 'restored'].includes(connection.phase) ||
          !connection.files.some((file) => targetPaths.has(file.path)),
        'CONNECTION_BUSY',
        `Resume or restore onboarding operation ${id} before sharing its connection`,
      );
    }
    for (const target of unique) {
      guard(
        !inside(core.store.root, target.configPath) &&
          !inside(core.store.root, target.bootstrapPath),
        'STORE_OVERLAP',
        'Connection targets must not overlap the Core store',
      );
      guard(
        !m.candidates.some((c) =>
          c.files.some((f) => child(c.path, f.relative) === target.bootstrapPath),
        ),
        'CONNECTION_GUIDE_CONFLICT',
        'Connection guide overlaps a discovered native asset',
      );
    }
    m.connection = installNativeConnections(
      path.join(directory(core, m.id), 'connections'),
      unique,
      endpoint,
      req.userRequest,
      bootstrap(endpoint),
    );
    return m;
  });
}
