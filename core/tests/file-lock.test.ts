import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const scratch: string[] = [];
afterEach(async () => {
  vi.doUnmock("node:fs");
  vi.doUnmock("node:fs/promises");
  vi.doUnmock("fs-native-extensions");
  vi.resetModules();
  await Promise.all(scratch.splice(0).map((directory) => fsPromises.rm(directory, { recursive: true, force: true })));
});

describe("native file lock", () => {
  it("does not block when a regular lock file becomes a FIFO before open", async () => {
    if (process.platform === "win32") return;
    const root = await fsPromises.mkdtemp(join(tmpdir(), "aacl-file-lock-test-"));
    scratch.push(root);
    const lockPath = join(root, "registry.lock");
    await fsPromises.writeFile(lockPath, "", "utf8");

    let replaced = false;
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        lstatSync: (...args: any[]) => {
          const info = Reflect.apply(actual.lstatSync, actual, args) as fs.Stats;
          if (!replaced && args[0] === lockPath) {
            actual.unlinkSync(lockPath);
            execFileSync("mkfifo", [lockPath]);
            replaced = true;
          }
          return info;
        },
      };
    });
    vi.resetModules();
    const { withFileLock } = await import("../src/internal/file-lock.ts");

    const result = await Promise.race([
      withFileLock(lockPath, async () => "unexpected", { timeoutMs: 250, pollMs: 5 })
        .then(() => undefined, (error: unknown) => error),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("FIFO open blocked")), 1_000)),
    ]);

    expect(result).toMatchObject({ code: "ECOMPROMISED" });
    expect(replaced).toBe(true);
  });

  it("keeps a completed result when native unlock and close both fail", async () => {
    const root = await fsPromises.mkdtemp(join(tmpdir(), "aacl-file-lock-test-"));
    scratch.push(root);
    const lockPath = join(root, "registry.lock");
    const events: string[] = [];

    vi.doMock("fs-native-extensions", async () => {
      const actual = await vi.importActual<typeof import("fs-native-extensions")>("fs-native-extensions");
      return {
        ...actual,
        tryLock: () => true,
        unlock: () => {
          events.push("unlock");
          throw new Error("simulated unlock failure");
        },
      };
    });
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return {
        ...actual,
        open: async (...args: any[]) => {
          const handle = await Reflect.apply(actual.open, actual, args) as fsPromises.FileHandle;
          return new Proxy(handle, {
            get(target, property) {
              if (property === "close") {
                return async () => {
                  events.push("close");
                  await target.close();
                  throw new Error("simulated close failure");
                };
              }
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        },
      };
    });
    vi.resetModules();
    const { withFileLock } = await import("../src/internal/file-lock.ts");

    await expect(withFileLock(lockPath, async () => "committed")).resolves.toBe("committed");
    expect(events).toEqual(["unlock", "close"]);
    expect((await fsPromises.lstat(lockPath)).isFile()).toBe(true);
  });
});
