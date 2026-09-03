import { observeMarker } from "./marker-observer.ts";

const projectRoot = process.argv[2];

if (process.argv.length !== 3 || projectRoot === undefined) {
  process.exitCode = 2;
} else {
  process.stdout.on("error", () => {
    process.exitCode = 1;
  });
  try {
    const observation = await observeMarker(projectRoot);
    process.stdout.write(`${JSON.stringify(observation)}\n`);
  } catch {
    process.exitCode = 1;
  }
}
