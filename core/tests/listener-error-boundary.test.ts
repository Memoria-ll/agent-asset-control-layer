import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { parseCoreErrorDto } from "@aacl/shared";
import { createJsonLogger } from "../src/logging/logger.ts";
import { createRequestListener } from "../src/http/listener.ts";

const listen = (server: ReturnType<typeof createServer>): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("The test server has no TCP address."));
        return;
      }
      resolve(address.port);
    });
  });

const close = (server: ReturnType<typeof createServer>): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });

describe("request listener error boundary", () => {
  it("returns a contract-valid 500 when route handling throws", async () => {
    const lines: string[] = [];
    const logger = createJsonLogger(
      (line) => lines.push(line),
      () => new Date("2026-08-30T12:00:00.000Z"),
    );
    const server = createServer(
      createRequestListener({
        logger,
        routes: () => {
          throw new Error("boom");
        },
      }),
    );

    try {
      const port = await listen(server);
      const response = await Promise.race([
        fetch(`http://127.0.0.1:${port}/health`),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("request timed out")), 5000),
        ),
      ]);
      const body = parseCoreErrorDto(await response.json());

      expect(response.status).toBe(500);
      expect(body.code).toBe("internal");
      expect(body.message).not.toContain("boom");
      expect(
        lines.map((line) => (JSON.parse(line) as { event: string }).event),
      ).toContain("core.request_failed");
    } finally {
      if (server.listening) {
        server.closeAllConnections();
        await close(server);
      }
    }
  });
});
