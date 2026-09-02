import lockfile from "@bybrave/proper-lockfile2";

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type FileLockOptions = {
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly staleMs?: number;
  readonly updateMs?: number;
};

export const DEFAULT_FILE_LOCK_OPTIONS: Required<FileLockOptions> = {
  timeoutMs: 30_000,
  pollMs: 20,
  staleMs: 10_000,
  updateMs: 5_000,
};

export class FileLockTimeoutError extends Error {
  public readonly code = "FILE_LOCK_TIMEOUT";

  public constructor(lockPath: string) {
    super(`Timed out waiting for file lock ${lockPath}.`);
    this.name = "FileLockTimeoutError";
  }
}

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

/**
 * Serialize a critical section across Node processes with heartbeat-based stale recovery.
 * Atomic rename protects one document; the lock protects the read-modify-write around it.
 */
export const withFileLock = async <T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> => {
  const normalizedPath = resolve(lockPath);
  const settings = { ...DEFAULT_FILE_LOCK_OPTIONS, ...options };
  const deadline = Date.now() + settings.timeoutMs;
  let release: (() => Promise<void>) | undefined;
  let compromised: Error | undefined;

  await mkdir(dirname(normalizedPath), { recursive: true, mode: 0o700 });
  while (release === undefined) {
    try {
      release = await lockfile.lock(normalizedPath, {
        realpath: false,
        lockfilePath: normalizedPath,
        stale: settings.staleMs,
        update: settings.updateMs,
        onCompromised: (error) => {
          compromised = error;
        },
      });
    } catch (error) {
      if (errorCode(error) !== "ELOCKED") throw error;
      if (Date.now() >= deadline) throw new FileLockTimeoutError(normalizedPath);
      await delay(settings.pollMs);
    }
  }

  let operationCompleted = false;
  try {
    const result = await operation();
    operationCompleted = true;
    return result;
  } finally {
    let releaseFailure: unknown;
    try {
      await release();
    } catch (error) {
      releaseFailure = error;
    }
    if (operationCompleted) {
      if (releaseFailure !== undefined) throw releaseFailure;
      if (compromised !== undefined) throw compromised;
    }
  }
};
