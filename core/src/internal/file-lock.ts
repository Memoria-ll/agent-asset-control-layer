import { constants, lstatSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { tryLock, unlock } from "fs-native-extensions";

export type FileLockOptions = {
  readonly timeoutMs?: number;
  readonly pollMs?: number;
};

export type FileLockGuard = () => void;

export const DEFAULT_FILE_LOCK_OPTIONS: Required<FileLockOptions> = {
  timeoutMs: 5_000,
  pollMs: 20,
};

export class FileLockTimeoutError extends Error {
  public readonly code = "FILE_LOCK_TIMEOUT";

  public constructor(lockPath: string) {
    super(`Timed out waiting for file lock ${lockPath}.`);
    this.name = "FileLockTimeoutError";
  }
}

type LockIdentity = {
  readonly dev: number;
  readonly ino: number;
};

type LockOwnershipError = NodeJS.ErrnoException;

type OpenedLock = {
  readonly handle: FileHandle;
  readonly identity: LockIdentity;
};

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

const lockOwnershipError = (message: string): LockOwnershipError => {
  const error = new Error(message) as LockOwnershipError;
  error.code = "ECOMPROMISED";
  return error;
};

const identityOf = (info: { readonly dev: number; readonly ino: number }): LockIdentity => ({
  dev: info.dev,
  ino: info.ino,
});

const sameIdentity = (left: LockIdentity, right: LockIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const readLockIdentity = (lockPath: string): LockIdentity => {
  const info = lstatSync(lockPath);
  if (!info.isFile()) {
    throw lockOwnershipError("The file lock path is not a regular file.");
  }
  return identityOf(info);
};

const openFlags = (): number => {
  // O_NOFOLLOW and O_NONBLOCK are POSIX-only. The post-open lstat/fstat identity check remains the
  // cross-platform guard against a symlink or replacement appearing during acquisition.
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const nonBlocking = process.platform === "win32" || typeof constants.O_NONBLOCK !== "number"
    ? 0
    : constants.O_NONBLOCK;
  return constants.O_RDWR | constants.O_CREAT | noFollow | nonBlocking;
};

const closeBestEffort = async (handle: FileHandle): Promise<void> => {
  try {
    await handle.close();
  } catch {
    // Acquisition has not obtained native ownership, so no pathname cleanup is required.
  }
};

const openPermanentLock = async (lockPath: string): Promise<OpenedLock> => {
  try {
    readLockIdentity(lockPath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }

  let handle: FileHandle | undefined;
  try {
    handle = await open(lockPath, openFlags(), 0o600);
    const descriptorInfo = await handle.stat();
    const pathIdentity = readLockIdentity(lockPath);
    const descriptorIdentity = identityOf(descriptorInfo);
    if (!descriptorInfo.isFile() || !sameIdentity(pathIdentity, descriptorIdentity)) {
      throw lockOwnershipError("The file lock path changed during acquisition.");
    }
    return { handle, identity: pathIdentity };
  } catch (error) {
    if (handle !== undefined) await closeBestEffort(handle);
    throw error;
  }
};

const releaseNativeLock = async (opened: OpenedLock): Promise<void> => {
  try {
    unlock(opened.handle.fd);
  } catch {
    // The descriptor close below is still required when native unlock reports an error.
  }
  try {
    await opened.handle.close();
  } catch {
    // A cleanup failure cannot reverse a completed Registry commit.
  }
};

const verifyOwnedLock = (lockPath: string, identity: LockIdentity): LockOwnershipError | undefined => {
  try {
    const currentIdentity = readLockIdentity(lockPath);
    return sameIdentity(currentIdentity, identity)
      ? undefined
      : lockOwnershipError("The file lock was replaced before the critical section completed.");
  } catch {
    return lockOwnershipError("The file lock ownership could not be verified.");
  }
};

const acquireNativeLock = async (
  lockPath: string,
  settings: Required<FileLockOptions>,
): Promise<OpenedLock> => {
  const opened = await openPermanentLock(lockPath);
  const deadline = performance.now() + settings.timeoutMs;
  try {
    while (true) {
      if (tryLock(opened.handle.fd)) return opened;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new FileLockTimeoutError(lockPath);
      await delay(Math.min(Math.max(settings.pollMs, 0), remaining));
    }
  } catch (error) {
    await closeBestEffort(opened.handle);
    throw error;
  }
};

/**
 * Serialize a critical section across Node processes with an OS-native advisory lock.
 * The lock pathname is a permanent regular file: only the native lock and descriptor lifetime
 * express ownership, so process termination releases ownership without path cleanup.
 */
export const withFileLock = async <T>(
  lockPath: string,
  operation: (assertOwned: FileLockGuard) => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> => {
  const normalizedPath = resolve(lockPath);
  const settings = { ...DEFAULT_FILE_LOCK_OPTIONS, ...options };
  await mkdir(dirname(normalizedPath), { recursive: true, mode: 0o700 });

  const opened = await acquireNativeLock(normalizedPath, settings);
  let compromised: LockOwnershipError | undefined;
  let ownershipIntact = true;
  const assertOwned: FileLockGuard = () => {
    if (compromised !== undefined) {
      ownershipIntact = false;
      throw compromised;
    }
    const failure = verifyOwnedLock(normalizedPath, opened.identity);
    if (failure !== undefined) {
      ownershipIntact = false;
      compromised = failure;
      throw failure;
    }
  };

  let operationCompleted = false;
  try {
    assertOwned();
    const result = await operation(assertOwned);
    operationCompleted = true;
    return result;
  } finally {
    if (ownershipIntact && compromised === undefined) {
      try {
        // The operation invokes this guard immediately before its final rename; repeat it here
        // to catch a replacement that appears after the operation has returned.
        assertOwned();
      } catch {
        // The ownership failure is surfaced below; the descriptor still must be unlocked.
      }
    }
    await releaseNativeLock(opened);
    if (operationCompleted && compromised !== undefined) throw compromised;
  }
};
