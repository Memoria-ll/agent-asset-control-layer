import { mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { observeMarker } from "../../src/projects/marker-observer.ts";

const projectRoot = process.argv[2];

if (projectRoot === undefined) {
  process.exitCode = 2;
} else {
  process.stdout.on("error", () => {
    process.exitCode = 1;
  });
  const projectDirectory = join(projectRoot, ".aacl");
  const replacementDirectory = join(projectRoot, ".aacl-replacement");
  const observation = await observeMarker(projectRoot, {
    afterDirectoryFreshStat: async () => {
      await mkdir(replacementDirectory);
      await writeFile(join(replacementDirectory, "project.json"), JSON.stringify({
        schemaVersion: 1,
        projectId: "project-replacement",
      }), "utf8");
      await rename(projectDirectory, `${projectDirectory}-original`);
      await symlink(replacementDirectory, projectDirectory, "dir");
    },
  });
  process.stdout.write(`${JSON.stringify(observation)}\n`);
}
