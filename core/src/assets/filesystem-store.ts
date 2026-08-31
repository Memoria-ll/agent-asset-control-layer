import { randomUUID, createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename as renameFile,
  stat,
  lstat,
  unlink,
} from "node:fs/promises";
import type { Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  parseAssetDocument,
  serializeCanonicalAsset,
  validateAsset,
  type AssetResult,
  type CanonicalAsset,
} from "@aacl/core-domain";
import type { AssetId, AssetRevision } from "@aacl/shared";
import { coreFailure, type CoreFailure } from "@aacl/core-domain";

export type ManagedAssetRoot =
  | { readonly rootId: string; readonly kind: "global" | "personal"; readonly directory: string }
  | { readonly rootId: string; readonly kind: "project"; readonly directory: string; readonly projectId: string };

export type AssetLocation =
  | { readonly rootId: string; readonly kind: "global" | "personal"; readonly relativePath?: string }
  | { readonly rootId: string; readonly kind: "project"; readonly projectId: string; readonly relativePath?: string };

export type StoredAssetSource =
  | { readonly rootId: string; readonly kind: "global" | "personal"; readonly relativePath: string }
  | { readonly rootId: string; readonly kind: "project"; readonly projectId: string; readonly relativePath: string };

export type StoredAsset = {
  readonly asset: CanonicalAsset;
  readonly revision: AssetRevision;
  readonly source: StoredAssetSource;
};

export type AssetDiagnostic = {
  readonly source: AssetLocation;
  readonly failure: CoreFailure;
};

export type AssetListResult = {
  readonly assets: readonly StoredAsset[];
  readonly failures: readonly AssetDiagnostic[];
};

export type AssetLookupResult = {
  readonly matches: readonly StoredAsset[];
  readonly failures: readonly AssetDiagnostic[];
};

export type SaveAssetInput = {
  readonly rootId: string;
  readonly relativePath: string;
  readonly asset: CanonicalAsset;
  readonly expectedRevision?: AssetRevision;
};

export type AssetStore = {
  readonly list: () => Promise<AssetListResult>;
  readonly get: (assetId: AssetId) => Promise<AssetLookupResult>;
  readonly save: (input: SaveAssetInput) => Promise<AssetResult<StoredAsset>>;
};

type Rename = (from: string, to: string) => Promise<void>;

type RootState = {
  readonly descriptor: ManagedAssetRoot;
};

type FileEntry = {
  readonly root: RootState;
  readonly relativePath: string;
  readonly symlink: boolean;
};

type ReadOutcome =
  | { readonly kind: "ignored" }
  | { readonly kind: "asset"; readonly stored: StoredAsset }
  | { readonly kind: "failure"; readonly failure: CoreFailure };

type TargetOutcome =
  | { readonly kind: "missing" }
  | { readonly kind: "asset"; readonly stored: StoredAsset; readonly mode: number }
  | { readonly kind: "failure"; readonly failure: CoreFailure };

const detail = (path: readonly string[], code: string, message: string) => ({
  path: [...path],
  code,
  message,
});

const failure = (
  code: "invalid_request" | "incompatible_contract" | "unavailable" | "conflict" | "internal",
  message: string,
  path: readonly string[],
  codeDetail: string,
): CoreFailure => coreFailure(code, message, [detail(path, codeDetail, message)]);

const errorCode = (error: unknown): string | undefined => {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
};

const isErrorCode = (error: unknown, code: string): boolean => errorCode(error) === code;

const rootLocation = (root: ManagedAssetRoot): AssetLocation =>
  root.kind === "project"
    ? { rootId: root.rootId, kind: root.kind, projectId: root.projectId }
    : { rootId: root.rootId, kind: root.kind };

const fileLocation = (root: ManagedAssetRoot, relativePath: string): AssetLocation =>
  root.kind === "project"
    ? { rootId: root.rootId, kind: root.kind, projectId: root.projectId, relativePath }
    : { rootId: root.rootId, kind: root.kind, relativePath };

const storedSource = (root: ManagedAssetRoot, relativePath: string): StoredAssetSource =>
  root.kind === "project"
    ? { rootId: root.rootId, kind: root.kind, projectId: root.projectId, relativePath }
    : { rootId: root.rootId, kind: root.kind, relativePath };

const pathFor = (rootDirectory: string, relativePath: string): string =>
  resolve(rootDirectory, ...relativePath.split("/"));

const isContainedPath = (rootDirectory: string, targetPath: string): boolean => {
  const remainder = relative(rootDirectory, targetPath);
  return remainder !== "" && !isAbsolute(remainder) && remainder !== ".." && !remainder.startsWith(`..${"/"}`) && !remainder.startsWith(`..${"\\"}`);
};

const rootsOverlap = (left: string, right: string): boolean =>
  left === right || isContainedPath(left, right) || isContainedPath(right, left);

const WINDOWS_RESERVED_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "COM¹", "COM²", "COM³",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9", "LPT¹", "LPT²", "LPT³",
]);

const saveChains = new Map<string, Promise<unknown>>();

const portableSegment = (segment: string): boolean => {
  if (/[<>"|?*]/.test(segment)) return false;
  if ([...segment].some((character) => (character.codePointAt(0) ?? 0) < 0x20)) return false;
  if (/[. ]$/.test(segment)) return false;
  const stem = segment.split(".")[0]?.replace(/ +$/, "");
  return stem !== undefined && !WINDOWS_RESERVED_NAMES.has(stem.toUpperCase());
};

const validRelativePath = (value: string): boolean => {
  // Windows forbids ":" in a file name, where it denotes an alternate data stream, and a
  // managed root is seen as one store from both Windows and WSL, so a name that only POSIX
  // accepts cannot be admitted.
  if (value.length === 0 || value.includes("\\") || value.includes(":") || value.includes("\0") || value.startsWith("/")) return false;
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return false;
  // list reads existing names on disk as-is because the human-readable filesystem is the source
  // of truth; only names newly created by save are restricted to the set valid on Windows.
  if (segments.some((segment) => !portableSegment(segment))) return false;
  const name = segments[segments.length - 1];
  return name !== undefined && name !== ".md" && name.endsWith(".md");
};

const validateRoot = (root: unknown): root is ManagedAssetRoot => {
  if (root === null || typeof root !== "object") return false;
  if (!("rootId" in root) || !("kind" in root) || !("directory" in root)) return false;
  const candidate = root as { rootId?: unknown; kind?: unknown; directory?: unknown; projectId?: unknown };
  if (typeof candidate.rootId !== "string" || candidate.rootId.trim() === "") return false;
  if (typeof candidate.directory !== "string" || candidate.directory.trim() === "" || !isAbsolute(candidate.directory)) return false;
  if (candidate.kind === "project") {
    return typeof candidate.projectId === "string" && candidate.projectId.trim() !== "";
  }
  return (candidate.kind === "global" || candidate.kind === "personal") && !("projectId" in candidate);
};

const strictDecode = (bytes: Buffer): AssetResult<string> => {
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { ok: true, value };
  } catch {
    return {
      ok: false,
      failure: failure("invalid_request", "The asset file is not valid UTF-8.", ["document"], "invalid_utf8"),
    };
  }
};

const hasAssetDelimiter = (bytes: Buffer): boolean => {
  const bomOffset = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const end = bytes.indexOf(0x0a, bomOffset);
  const line = bytes.subarray(bomOffset, end < 0 ? bytes.length : end);
  const withoutCr = line[line.length - 1] === 0x0d ? line.subarray(0, line.length - 1) : line;
  return withoutCr.length === 3 && withoutCr[0] === 0x2d && withoutCr[1] === 0x2d && withoutCr[2] === 0x2d;
};

const withFilePath = (root: ManagedAssetRoot, relativePath: string, sourceFailure: CoreFailure): CoreFailure => {
  const details = sourceFailure.details;
  if (details === undefined) {
    return coreFailure(sourceFailure.code, sourceFailure.message, [
      detail(["root", root.rootId, "file", relativePath], "unavailable", sourceFailure.message),
    ]);
  }
  return coreFailure(
    sourceFailure.code,
    sourceFailure.message,
    details.map((item) => {
      const path = item.path[0] === "document"
        ? ["root", root.rootId, "file", relativePath, ...item.path.slice(1)]
        : item.path[0] === "root"
          ? [...item.path]
          : ["root", root.rootId, "file", relativePath, ...item.path];
      return { ...item, path };
    }),
  );
};

const diagnostic = (root: ManagedAssetRoot, relativePath: string | undefined, sourceFailure: CoreFailure): AssetDiagnostic => ({
  source: relativePath === undefined ? rootLocation(root) : fileLocation(root, relativePath),
  failure: relativePath === undefined ? sourceFailure : withFilePath(root, relativePath, sourceFailure),
});

const makeAssetRevision = (document: string): AssetRevision => {
  const digest = createHash("sha256").update(Buffer.from(document, "utf8")).digest("hex");
  return `sha256:${digest}` as AssetRevision;
};

const listDirectoryEntries = async (directory: string): Promise<Dirent[]> => readdir(directory, { withFileTypes: true });

const collectEntries = async (
  root: RootState,
  directory: string,
  prefix: string,
): Promise<{ readonly entries: readonly FileEntry[]; readonly failures: readonly CoreFailure[] }> => {
  let directoryEntries: Dirent[];
  try {
    directoryEntries = await listDirectoryEntries(directory);
  } catch (error) {
    const code = errorCode(error);
    const unavailable = code !== "ENOENT" && code !== "ENOTDIR";
    return {
      entries: [],
      failures: [unavailable
        ? failure(
          "unavailable",
          "The asset root could not be read.",
          prefix === "" ? ["root", root.descriptor.rootId] : ["root", root.descriptor.rootId, "file", prefix],
          "unavailable",
        )
        : failure(
          "invalid_request",
          "The asset root could not be read as a directory.",
          prefix === "" ? ["root", root.descriptor.rootId] : ["root", root.descriptor.rootId, "file", prefix],
          "invalid_root",
        )],
    };
  }

  const entries: FileEntry[] = [];
  const failures: CoreFailure[] = [];
  for (const entry of directoryEntries) {
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const fullPath = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      if (entry.name.endsWith(".md")) entries.push({ root, relativePath, symlink: true });
      continue;
    }
    if (entry.isDirectory()) {
      const nested = await collectEntries(root, fullPath, relativePath);
      entries.push(...nested.entries);
      failures.push(...nested.failures);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) entries.push({ root, relativePath, symlink: false });
  }
  return { entries, failures };
};

const readAndValidate = async (root: RootState, entry: FileEntry, rootDirectory: string): Promise<ReadOutcome> => {
  if (entry.symlink) {
    return {
      kind: "failure",
      failure: failure(
        "invalid_request",
        "Symbolic-link asset files are not supported.",
        ["root", root.descriptor.rootId, "file", entry.relativePath],
        "unsupported_symlink",
      ),
    };
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(join(rootDirectory, ...entry.relativePath.split("/")));
  } catch {
    return {
      kind: "failure",
      failure: failure("unavailable", "The asset file could not be read.", ["root", root.descriptor.rootId, "file", entry.relativePath], "unavailable"),
    };
  }
  // A file without the opening delimiter is not an asset at all, so it is neither a
  // candidate nor a diagnostic. This runs on the raw bytes and before decoding: a README
  // that happens to hold invalid UTF-8 must not surface as a decode failure.
  if (!hasAssetDelimiter(bytes)) return { kind: "ignored" };

  const decoded = strictDecode(bytes);
  if (!decoded.ok) return { kind: "failure", failure: decoded.failure };
  const parsed = parseAssetDocument(decoded.value);
  if (!parsed.ok) return { kind: "failure", failure: parsed.failure };
  const validated = validateAsset(parsed.value);
  if (!validated.ok) return { kind: "failure", failure: validated.failure };
  const serialized = serializeCanonicalAsset(validated.value);
  if (!serialized.ok) return { kind: "failure", failure: serialized.failure };

  return {
    kind: "asset",
    stored: {
      asset: validated.value,
      revision: makeAssetRevision(serialized.value),
      source: storedSource(root.descriptor, entry.relativePath),
    },
  };
};

const scanRoot = async (root: RootState): Promise<{ readonly assets: readonly StoredAsset[]; readonly failures: readonly AssetDiagnostic[] }> => {
  let rootDirectory: string;
  try {
    rootDirectory = await realpath(root.descriptor.directory);
    const rootStat = await stat(rootDirectory);
    if (!rootStat.isDirectory()) {
      return { assets: [], failures: [diagnostic(root.descriptor, undefined, failure("invalid_request", "The asset root is not a directory.", ["root", root.descriptor.rootId], "invalid_root"))] };
    }
  } catch (error) {
    // A root that is absent or not a directory is a caller mistake, not an outage, so it
    // must not travel as "unavailable": STATUS_BY_CODE in ../http/responses.ts maps that
    // code to 503, which would report a mistyped root path as a Core service failure.
    const code = errorCode(error);
    const rootFailure = code === "ENOENT" || code === "ENOTDIR"
      ? failure("invalid_request", "The asset root does not exist or is not a directory.", ["root", root.descriptor.rootId], "invalid_root")
      : failure("unavailable", "The asset root could not be accessed.", ["root", root.descriptor.rootId], "unavailable");
    return { assets: [], failures: [diagnostic(root.descriptor, undefined, rootFailure)] };
  }

  const collected = await collectEntries(root, rootDirectory, "");
  const entries = [...collected.entries].sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
  const assets: StoredAsset[] = [];
  const failures: AssetDiagnostic[] = [];
  for (const entry of entries) {
    const result = await readAndValidate(root, entry, rootDirectory);
    if (result.kind === "asset") assets.push(result.stored);
    if (result.kind === "failure") failures.push(diagnostic(root.descriptor, entry.relativePath, result.failure));
  }
  for (const collectedFailure of collected.failures) {
    failures.push(diagnostic(root.descriptor, undefined, collectedFailure));
  }
  return { assets, failures };
};

const duplicateDiagnostics = (assets: readonly StoredAsset[]): AssetDiagnostic[] => {
  const seen = new Map<string, StoredAsset>();
  const duplicates: AssetDiagnostic[] = [];
  for (const stored of assets) {
    const key = `${stored.source.rootId}:${stored.asset.id}`;
    const previous = seen.get(key);
    if (previous === undefined) {
      seen.set(key, stored);
      continue;
    }
    duplicates.push({
      source: stored.source,
      failure: coreFailure("conflict", `Asset id "${stored.asset.id}" is declared more than once in root "${stored.source.rootId}".`, [
        detail(["root", stored.source.rootId, "file", stored.source.relativePath, "frontmatter", "id"], "duplicate_asset_id", `Asset id "${stored.asset.id}" is declared more than once in this root.`),
      ]),
    });
  }
  return duplicates;
};

const validateTargetPath = (relativePath: string): AssetResult<undefined> => {
  if (!validRelativePath(relativePath)) {
    return {
      ok: false,
      failure: failure("invalid_request", "The asset path is outside the managed asset path policy.", ["file", relativePath], "path_outside_root"),
    };
  }
  return { ok: true, value: undefined };
};

const ensureNoSymlink = async (rootDirectory: string, targetDirectory: string): Promise<AssetResult<undefined>> => {
  const remainder = relative(rootDirectory, targetDirectory);
  const segments = remainder.split(/[\\/]/).filter((segment) => segment !== "");
  let current = rootDirectory;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        return {
          ok: false,
          failure: failure("invalid_request", "The asset path crosses a symbolic link.", ["file"], "unsupported_symlink"),
        };
      }
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) continue;
      return {
        ok: false,
        failure: failure("unavailable", "The asset path could not be inspected.", ["file"], "unavailable"),
      };
    }
  }
  return { ok: true, value: undefined };
};

const targetState = async (root: RootState, rootDirectory: string, relativePath: string): Promise<TargetOutcome> => {
  const targetPath = pathFor(rootDirectory, relativePath);
  let targetStat;
  try {
    targetStat = await lstat(targetPath);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return { kind: "missing" };
    return { kind: "failure", failure: failure("unavailable", "The save target could not be inspected.", ["file", relativePath], "unavailable") };
  }
  if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
    return { kind: "failure", failure: failure("conflict", "The save target is not a regular asset file.", ["file", relativePath], "target_identity_mismatch") };
  }
  const readResult = await readAndValidate(root, { root, relativePath, symlink: false }, rootDirectory);
  if (readResult.kind === "ignored") {
    return { kind: "failure", failure: failure("conflict", "The save target does not contain a canonical asset.", ["file", relativePath], "target_identity_mismatch") };
  }
  if (readResult.kind === "failure") {
    return readResult.failure.code === "unavailable"
      ? { kind: "failure", failure: readResult.failure }
      : { kind: "failure", failure: failure("conflict", "The save target contains an invalid asset.", ["file", relativePath], "target_identity_mismatch") };
  }
  return { kind: "asset", stored: readResult.stored, mode: targetStat.mode & 0o777 };
};

const cleanupTemp = async (temporaryPath: string | undefined): Promise<void> => {
  if (temporaryPath === undefined) return;
  try {
    await unlink(temporaryPath);
  } catch {
    // The caller is already reporting the save failure that led here, and a leftover
    // temporary file is not worth replacing that failure with a different one.
  }
};

// Only the rename is injectable. Widening this to the whole write would move the atomic
// sequence into the test's substitute, so the exclusive create, the close and the cleanup
// below would no longer be the code any test observes.
const writeAtomically = async (
  targetPath: string,
  document: string,
  rename: Rename,
  mode?: number,
): Promise<AssetResult<undefined>> => {
  const parent = dirname(targetPath);
  const temporaryPath = join(parent, `.aacl.${randomUUID()}.tmp`);
  let activeTemporaryPath: string | undefined = temporaryPath;
  let handle: FileHandle | undefined;
  try {
    // umask can only narrow the mode open is given, so a restriction has to be in place at
    // creation or the content is briefly readable. Widening is reachable only by chmod after
    // the write, and that merely restores the mode the target already had.
    handle = await open(temporaryPath, "wx", mode ?? 0o666);
    await handle.writeFile(document, "utf8");
    if (mode !== undefined) await handle.chmod(mode);
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, targetPath);
    activeTemporaryPath = undefined;
    return { ok: true, value: undefined };
  } catch {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // Cleanup below still removes the temporary pathname after close failure.
      }
    }
    await cleanupTemp(activeTemporaryPath);
    return {
      ok: false,
      failure: failure("unavailable", "The asset could not be saved atomically.", ["file", basename(targetPath)], "unavailable"),
    };
  }
};

export const createFilesystemAssetStore = (
  roots: readonly ManagedAssetRoot[],
  options?: { readonly rename?: Rename },
): AssetResult<AssetStore> => {
  const seenRootIds = new Set<string>();
  const seenRootDirectories: string[] = [];
  for (const root of roots) {
    if (!validateRoot(root)) {
      return {
        ok: false,
        failure: failure("invalid_request", "The managed asset roots are invalid.", ["root"], "invalid_root"),
      };
    }
    const normalizedDirectory = resolve(root.directory);
    // Root identity checks stop at resolve: symlink aliases and case-insensitive filesystem
    // aliases require filesystem inspection beyond lexical normalization (#60).
    if (seenRootIds.has(root.rootId) || seenRootDirectories.some((seen) => rootsOverlap(seen, normalizedDirectory))) {
      return {
        ok: false,
        failure: failure("invalid_request", "The managed asset roots are invalid.", ["root"], "invalid_root"),
      };
    }
    seenRootIds.add(root.rootId);
    seenRootDirectories.push(normalizedDirectory);
  }

  const states = roots.map((descriptor) => ({ descriptor }));
  const rename = options?.rename ?? renameFile;

  const list = async (): Promise<AssetListResult> => {
    const assets: StoredAsset[] = [];
    const failures: AssetDiagnostic[] = [];
    for (const root of states) {
      const result = await scanRoot(root);
      assets.push(...result.assets);
      failures.push(...result.failures);
    }
    failures.push(...duplicateDiagnostics(assets));
    return { assets, failures };
  };

  const get = async (assetId: AssetId): Promise<AssetLookupResult> => {
    const result = await list();
    return {
      matches: result.assets.filter((stored) => stored.asset.id === assetId),
      failures: result.failures,
    };
  };

  const saveSerialized = async (root: RootState, input: SaveAssetInput): Promise<AssetResult<StoredAsset>> => {
    let rootDirectory: string;
    try {
      rootDirectory = await realpath(root.descriptor.directory);
      if (!(await stat(rootDirectory)).isDirectory()) {
        return { ok: false, failure: failure("invalid_request", "The asset root is not a directory.", ["root", input.rootId], "invalid_root") };
      }
    } catch (error) {
      const code = errorCode(error);
      return {
        ok: false,
        failure: code === "ENOENT" || code === "ENOTDIR"
          ? failure("invalid_request", "The asset root does not exist or is not a directory.", ["root", input.rootId], "invalid_root")
          : failure("unavailable", "The asset root could not be accessed.", ["root", input.rootId], "unavailable"),
      };
    }

    const targetPath = pathFor(rootDirectory, input.relativePath);
    if (!isContainedPath(rootDirectory, targetPath)) {
      return { ok: false, failure: failure("invalid_request", "The asset path is outside the managed asset root.", ["file", input.relativePath], "path_outside_root") };
    }
    const parentPath = dirname(targetPath);
    const parentCheck = await ensureNoSymlink(rootDirectory, parentPath);
    if (!parentCheck.ok) return parentCheck;

    const serialized = serializeCanonicalAsset(input.asset);
    if (!serialized.ok) return serialized;

    const target = await targetState(root, rootDirectory, input.relativePath);
    if (target.kind === "failure") return { ok: false, failure: target.failure };
    if (input.expectedRevision !== undefined) {
      if (target.kind !== "asset" || target.stored.revision !== input.expectedRevision) {
        return { ok: false, failure: failure("conflict", "The asset revision no longer matches the save precondition.", ["file", input.relativePath], "target_identity_mismatch") };
      }
    } else if (target.kind === "asset" && target.stored.asset.id !== input.asset.id) {
      return { ok: false, failure: failure("conflict", "The save target contains a different asset id.", ["file", input.relativePath], "target_identity_mismatch") };
    }

    const current = await list();
    const duplicates = current.assets.filter((stored) =>
      stored.asset.id === input.asset.id &&
      stored.source.rootId === input.rootId &&
      stored.source.relativePath !== input.relativePath,
    );
    if (duplicates.length > 0) {
      // Saving the same id to a new path does not relocate the asset: the store offers no
      // delete or move, so removing the old file here would make save the only operation
      // that destroys a file the caller never named.
      // Device/inode comparison is not used: hard links are distinct files and must not be
      // treated as identical because rename-based writes create a new inode, which would leave
      // two files with the same id. realpath equates only alternate spellings/normalizations
      // of one path and does not equate hard links.
      const duplicateConflict = (relativePath: string): AssetResult<StoredAsset> => ({
        ok: false,
        failure: failure("conflict", `Asset id "${input.asset.id}" already exists at another path in this root.`, ["root", input.rootId, "file", relativePath], "duplicate_asset_id"),
      });
      const targetRealPath = await realpath(targetPath).catch(() => undefined);
      for (const duplicate of duplicates) {
        // A candidate is skipped only once it is positively established to be the target
        // itself; an unresolvable path on either side leaves identity unknown and stays a
        // conflict.
        if (targetRealPath !== undefined) {
          const duplicatePath = await realpath(pathFor(rootDirectory, duplicate.source.relativePath)).catch(() => undefined);
          if (duplicatePath === targetRealPath) continue;
        }
        return duplicateConflict(duplicate.source.relativePath);
      }
    }
    const unavailable = current.failures.find((item) =>
      item.source.rootId === input.rootId && item.failure.code === "unavailable"
    );
    if (unavailable !== undefined) return { ok: false, failure: unavailable.failure };

    try {
      await mkdir(parentPath, { recursive: true });
    } catch {
      return { ok: false, failure: failure("unavailable", "The asset directory could not be created.", ["file", input.relativePath], "unavailable") };
    }
    const parentAfterMkdir = await ensureNoSymlink(rootDirectory, parentPath);
    if (!parentAfterMkdir.ok) return parentAfterMkdir;

    const writeResult = await writeAtomically(targetPath, serialized.value, rename, target.kind === "asset" ? target.mode : undefined);
    if (!writeResult.ok) return writeResult;
    const stored: StoredAsset = {
      asset: input.asset,
      revision: makeAssetRevision(serialized.value),
      source: storedSource(root.descriptor, input.relativePath),
    };
    return { ok: true, value: stored };
  };

  // Save serialization is per normalized root directory and spans all store instances in this
  // Core process. Lexical resolve normalization gives symlink aliases and case variants on
  // case-insensitive filesystems different keys (#60); a writer outside this process can still
  // slip between the revision check and the rename (#59).
  const save = async (input: SaveAssetInput): Promise<AssetResult<StoredAsset>> => {
    const root = states.find((state) => state.descriptor.rootId === input.rootId);
    if (root === undefined) {
      return { ok: false, failure: failure("invalid_request", "The managed asset root is unknown.", ["root", input.rootId], "invalid_root") };
    }
    const pathResult = validateTargetPath(input.relativePath);
    if (!pathResult.ok) return pathResult;

    // Duplicate inspection covers the whole root (`stored.source.rootId === input.rootId`), so a
    // finer key lets another save in the same root pass inspection before either one writes.
    // saveSerialized calls list() on every save and scans the whole root, so a path key does not
    // provide useful parallelism.
    const key = resolve(root.descriptor.directory);
    const previous = saveChains.get(key) ?? Promise.resolve();
    const current = previous.then(
      () => saveSerialized(root, input),
      () => saveSerialized(root, input),
    );
    saveChains.set(key, current);
    try {
      return await current;
    } finally {
      if (saveChains.get(key) === current) saveChains.delete(key);
    }
  };

  return { ok: true, value: { list, get, save } };
};
