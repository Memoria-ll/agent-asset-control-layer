import { execFileSync } from "node:child_process";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { readRegularUtf8 } from "../src/internal/regular-file.ts";

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("regular file reads", () => {
  it("does not block when a regular file is replaced by a FIFO before open", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "aacl-regular-file-test-"));
    scratch.push(root);
    const filePath = join(root, "project.json");
    await writeFile(filePath, "{}\n", "utf8");

    const result = await Promise.race([
      readRegularUtf8(filePath, {
        beforeOpen: async () => {
          await unlink(filePath);
          execFileSync("mkfifo", [filePath]);
        },
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("FIFO open blocked")), 1_000)),
    ]);

    expect(result).toEqual({ status: "not_regular" });
  });
});
