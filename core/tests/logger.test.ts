import { describe, expect, it } from "vitest";
import { createJsonLogger } from "../src/logging/logger.ts";

describe("JSON logger", () => {
  it("writes one JSON object per log call without a newline", () => {
    const lines: string[] = [];
    const logger = createJsonLogger(
      (line) => lines.push(line),
      () => new Date("2026-08-30T12:00:00.000Z"),
    );

    logger.log("error", "core.request_failed", {
      attempt: 1,
      retryable: false,
      reason: "boom",
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      ts: "2026-08-30T12:00:00.000Z",
      level: "error",
      event: "core.request_failed",
      attempt: 1,
      retryable: false,
      reason: "boom",
    });
  });
});
