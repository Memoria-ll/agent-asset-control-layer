import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJsonLogger } from "./logging/logger.ts";
import type { Logger } from "./logging/logger.ts";
import { startCore, type StartOutcome } from "./index.ts";

const logger = createJsonLogger(
  (line) => {
    process.stdout.write(`${line}\n`);
  },
  () => new Date(),
);

export const runMain = async (
  start: typeof startCore = startCore,
  mainLogger: Logger = logger,
): Promise<void> => {
  let stopRequested = false;
  let stopping = false;
  let outcome: StartOutcome | undefined;
  let listeningAnnounced = false;

  const removeSignalHandlers = (): void => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };

  const stop = async (): Promise<void> => {
    stopRequested = true;
    if (outcome === undefined || !outcome.ok || stopping) return;
    stopping = true;
    if (listeningAnnounced) mainLogger.log("info", "core.stopping");
    try {
      await outcome.close();
      if (listeningAnnounced) mainLogger.log("info", "core.stopped");
    } finally {
      removeSignalHandlers();
    }
  };

  const onSignal = (): void => {
    stopRequested = true;
    void stop();
  };

  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const started = await start({ env: process.env, logger: mainLogger });
    outcome = started;
    if (stopRequested) {
      await stop();
      removeSignalHandlers();
      return;
    }
    if (!started.ok) {
      removeSignalHandlers();
      const event = started.stage === "settings"
        ? "core.settings_invalid"
        : started.stage === "project-registry"
          ? "core.project_registry_failed"
          : "core.listen_failed";
      mainLogger.log("error", event, { message: started.failure.message });
      process.exitCode = 1;
      return;
    }

    listeningAnnounced = true;
    mainLogger.log("info", "core.listening", started.address);
  } catch (error) {
    removeSignalHandlers();
    throw error;
  }
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runMain();
}
