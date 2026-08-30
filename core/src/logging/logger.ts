export type LogLevel = "info" | "warn" | "error";

export type LogFields = Readonly<Record<string, string | number | boolean>>;

export type Logger = {
  readonly log: (level: LogLevel, event: string, fields?: LogFields) => void;
};

export const createJsonLogger = (
  write: (line: string) => void,
  now: () => Date,
): Logger => ({
  log: (level, event, fields) => {
    const entry = {
      ts: now().toISOString(),
      level,
      event,
      ...(fields ?? {}),
    };
    write(JSON.stringify(entry));
  },
});
