import { createJsonLogger } from "./logging/logger.ts";
import { startCore } from "./index.ts";

const logger = createJsonLogger(
  (line) => {
    process.stdout.write(`${line}\n`);
  },
  () => new Date(),
);

const main = async (): Promise<void> => {
  const outcome = await startCore({ env: process.env, logger });
  if (!outcome.ok) {
    const event =
      outcome.failure.code === "invalid_request"
        ? "core.settings_invalid"
        : "core.listen_failed";
    logger.log("error", event, { message: outcome.failure.message });
    process.exitCode = 1;
    return;
  }

  logger.log("info", "core.listening", outcome.address);
  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.log("info", "core.stopping");
    await outcome.close();
    logger.log("info", "core.stopped");
  };

  process.once("SIGINT", () => {
    void stop();
  });
  process.once("SIGTERM", () => {
    void stop();
  });
};

void main();
