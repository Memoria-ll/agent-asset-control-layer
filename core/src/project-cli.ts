import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  createProjectRegistry,
  defaultProjectRegistryPath,
} from "./projects/registry.ts";
import { createProjectService } from "./projects/service.ts";

type CliIo = {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
};

export const runProjectCli = async (
  args: readonly string[],
  cwd: string,
  io: CliIo,
  registryPath = defaultProjectRegistryPath(),
): Promise<number> => {
  const normalizedArgs = args[1] === "--"
    ? [args[0], ...args.slice(2)]
    : args;
  if (normalizedArgs[0] !== "init" || normalizedArgs.length > 2) {
    io.stderr("Usage: pnpm project:init -- [project-root]");
    return 2;
  }
  const projectRoot = resolve(cwd, normalizedArgs[1] ?? ".");
  const service = createProjectService({
    registry: createProjectRegistry(registryPath),
  });
  const result = await service.initialize(projectRoot);
  if (!result.ok) {
    io.stderr(JSON.stringify(result.failure));
    return 1;
  }
  io.stdout(JSON.stringify(result.value));
  return 0;
};

const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const exitCode = await runProjectCli(
    process.argv.slice(2),
    process.env.INIT_CWD ?? process.cwd(),
    {
      stdout: (line) => process.stdout.write(`${line}\n`),
      stderr: (line) => process.stderr.write(`${line}\n`),
    },
  );
  process.exitCode = exitCode;
}
