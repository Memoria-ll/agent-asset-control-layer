import { describe, expect, it } from "vitest";
import { parseCoreErrorDto } from "@aacl/shared";
import { resolveCoreSettings } from "../src/config/settings.ts";

describe("core settings", () => {
  it("uses loopback defaults when environment variables are absent", () => {
    const result = resolveCoreSettings({});

    expect(result).toEqual({
      ok: true,
      settings: { host: "127.0.0.1", port: 7420 },
    });
  });

  it("accepts valid loopback hosts and ports", () => {
    for (const host of ["127.0.0.1", "localhost", "::1"]) {
      const result = resolveCoreSettings({
        AACL_CORE_HOST: host,
        AACL_CORE_PORT: "8123",
      });

      expect(result).toEqual({
        ok: true,
        settings: { host, port: 8123 },
      });
    }
  });

  it.each(["0", "65535"])("accepts port %s", (port) => {
    const result = resolveCoreSettings({ AACL_CORE_PORT: port });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.settings.port).toBe(Number(port));
  });

  it.each(["0x1f", " 7420 ", "1e3", "7.5", "", "+7420", "065", "65536"])(
    "rejects invalid port %s",
    (port) => {
      const result = resolveCoreSettings({ AACL_CORE_PORT: port });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.code).toBe("invalid_request");
        expect(() => parseCoreErrorDto({
          code: result.failure.code,
          message: result.failure.message,
        })).not.toThrow();
      }
    },
  );

  it.each(["", "   ", "0.0.0.0", "192.168.1.10"])(
    "rejects non-loopback host %s",
    (host) => {
      const result = resolveCoreSettings({ AACL_CORE_HOST: host });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.code).toBe("invalid_request");
    },
  );
});
