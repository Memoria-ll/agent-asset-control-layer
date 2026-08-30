import { describe, expect, it } from "vitest";
import {
  CONTRACT_VERSION,
  CORE_ERROR_CODES,
  parseCoreErrorDto,
  parseVersionInfo,
} from "@aacl/shared";
import { coreFailure } from "@aacl/core-domain";
import {
  errorResponse,
  healthResponse,
  responseForRoute,
  STATUS_BY_CODE,
} from "../src/http/responses.ts";

describe("HTTP responses", () => {
  it("returns the shared contract version from health", () => {
    const response = healthResponse();
    const body = JSON.parse(response.body) as unknown;

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/json");
    expect(parseVersionInfo(body)).toEqual({ contractVersion: CONTRACT_VERSION });
    expect(Object.keys(body as object)).toHaveLength(1);
  });

  it("serializes a contract-valid error response", () => {
    const response = errorResponse(coreFailure("not_found", "No route matches this request."));

    expect(response.status).toBe(404);
    expect(parseCoreErrorDto(JSON.parse(response.body))).toEqual({
      code: "not_found",
      message: "No route matches this request.",
    });
  });

  it("overrides invalid request with the method-not-allowed response", () => {
    const response = responseForRoute({ kind: "method-not-allowed" });

    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe("GET, HEAD");
    expect(parseCoreErrorDto(JSON.parse(response.body)).code).toBe("invalid_request");
  });

  it("defines a status for every shared error code", () => {
    for (const code of CORE_ERROR_CODES) {
      expect(Number.isInteger(STATUS_BY_CODE[code])).toBe(true);
      expect(STATUS_BY_CODE[code]).toBeGreaterThanOrEqual(400);
      expect(STATUS_BY_CODE[code]).toBeLessThanOrEqual(599);
    }
  });
});
