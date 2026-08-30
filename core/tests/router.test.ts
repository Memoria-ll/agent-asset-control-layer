import { describe, expect, it } from "vitest";
import { matchRoute } from "../src/http/router.ts";

describe("HTTP router", () => {
  it.each([
    ["GET", "/health"],
    ["HEAD", "/health"],
    ["GET", "/health?x=1&y=2"],
  ])("matches %s %s as health", (method, target) => {
    expect(matchRoute(method, target)).toEqual({ kind: "health" });
  });

  it("rejects methods other than GET and HEAD on health", () => {
    expect(matchRoute("POST", "/health")).toEqual({ kind: "method-not-allowed" });
  });

  it.each([
    ["GET", "/health/"],
    ["GET", "/HEALTH"],
    ["GET", "/"],
    ["GET", "*"],
    ["GET", "http://other/health"],
    [undefined, "/health"],
    ["GET", undefined],
  ])("returns not-found for %s %s", (method, target) => {
    expect(matchRoute(method, target)).toEqual({ kind: "not-found" });
  });
});
