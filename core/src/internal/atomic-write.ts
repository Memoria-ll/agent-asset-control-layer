import { randomUUID } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";

export type Rename = (from: string, to: string) => Promise<void>;

const cleanupTemp = async (temporaryPath: string | undefined): Promise<void> => {
  if (temporaryPath === undefined) return;
  try {
    await unlink(temporaryPath);
  } catch {
    // The caller is already reporting the save failure that led here, and a leftover
    // temporary file is not worth replacing that failure with a different one.
  }
};

/**
 * Replace `targetPath` with `document` in one step, or leave it untouched.
 *
 * Only the rename is injectable. Widening this to the whole write would move the atomic
 * sequence into the test's substitute, so the exclusive create, the close and the cleanup
 * below would no longer be the code any test observes.
 *
 * Failure comes back as `false` rather than as a `CoreFailure`: the message and the detail
 * path name what the caller was storing, and a shared helper cannot say "the asset" for one
 * caller and "the workflow state" for the next.
 */
export const writeAtomically = async (
  targetPath: string,
  document: string,
  rename: Rename,
  mode?: number,
): Promise<boolean> => {
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
    return true;
  } catch {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // Cleanup below still removes the temporary pathname after close failure.
      }
    }
    await cleanupTemp(activeTemporaryPath);
    return false;
  }
};
