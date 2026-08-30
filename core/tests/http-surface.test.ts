import { describe, expect, it } from "vitest";
import {
  parseCoreErrorDto,
  parseVersionInfo,
} from "@aacl/shared";
import { createJsonLogger } from "../src/logging/logger.ts";
import { startCore } from "../src/index.ts";

describe("Core HTTP surface", () => {
  it("serves health, errors, and shuts down cleanly", async () => {
    const logger = createJsonLogger(
      () => undefined,
      () => new Date("2026-08-30T12:00:00.000Z"),
    );
    const sigintListeners = process.listenerCount("SIGINT");
    const outcome = await startCore({
      env: { AACL_CORE_PORT: "0" },
      logger,
    });

    expect(process.listenerCount("SIGINT")).toBe(sigintListeners);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.failure.message);

    const url = `http://${outcome.address.host}:${outcome.address.port}`;
    try {
      expect(outcome.address.port).toBeGreaterThan(0);

      const health = await fetch(`${url}/health`);
      const healthBody = parseVersionInfo(await health.json());
      expect(health.status).toBe(200);
      expect(healthBody).toHaveProperty("contractVersion");

      const head = await fetch(`${url}/health`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");

      const healthWithQuery = await fetch(`${url}/health?x=1`);
      expect(healthWithQuery.status).toBe(200);

      const method = await fetch(`${url}/health`, { method: "POST" });
      expect(method.status).toBe(405);
      expect(method.headers.get("allow")).toBe("GET, HEAD");
      expect(parseCoreErrorDto(await method.json()).code).toBe("invalid_request");

      const missing = await fetch(`${url}/nope`);
      const missingBody = parseCoreErrorDto(await missing.json());
      expect(missing.status).toBe(404);
      expect(missingBody.code).toBe("not_found");
      expect("details" in missingBody).toBe(false);

      const trailingSlash = await fetch(`${url}/health/`);
      expect(trailingSlash.status).toBe(404);

    } finally {
      await outcome.close();
      await outcome.close();
    }

    await expect(fetch(`${url}/health`)).rejects.toThrow();
  });
});
