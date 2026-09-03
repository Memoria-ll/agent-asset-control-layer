import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { observeMarker } from "../../src/projects/marker-observer.ts";

const projectRoot = process.argv[2];

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
};

if (projectRoot === undefined) {
  process.exitCode = 2;
} else {
  process.stdout.on("error", () => {
    process.exitCode = 1;
  });
  await writeFile(join(projectRoot, ".aacl", "observer.pid"), String(process.pid), "utf8");
  let canObserve = false;
  try {
    const handle = await open(join(projectRoot, ".aacl", "stall.fifo"), "r");
    await handle.close();
    canObserve = true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") canObserve = true;
    else process.exitCode = 1;
  }
  if (canObserve) {
    const observation = await observeMarker(projectRoot);
    process.stdout.write(`${JSON.stringify(observation)}\n`);
  }
}
