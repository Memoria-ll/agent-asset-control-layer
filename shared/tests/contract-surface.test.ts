import { describe, expect, it } from "vitest";
import * as shared from "../src/index.js";
import { contractJsonSchemas } from "../src/index.js";

describe("published contract surface", () => {
  it("registers every exported parser schema", () => {
    const parserSchemaNames = Object.entries(shared)
      .filter(([name, value]) => name.startsWith("parse") && typeof value === "function")
      .map(([name]) => name.slice("parse".length));
    const registeredSchemaNames = Object.keys(contractJsonSchemas());

    expect(parserSchemaNames.sort()).toEqual(registeredSchemaNames.sort());
  });

  /**
   * `core` and `vscode-extension` declare no zod dependency, and that missing
   * dependency is what enforces the boundary instead of a reviewer noticing.
   * Publishing either of these hands the enforcement back to the reviewer: one
   * takes a `$ZodError` a consumer cannot construct, the other is a registry of
   * zod schemas whose every use is a zod operation.
   */
  it.each(["toCoreError", "contractSchemas"])(
    "keeps %s off the published surface",
    (name) => {
      expect(Object.keys(shared)).not.toContain(name);
    },
  );

  it("publishes the JSON form of the registry instead", () => {
    expect(Object.keys(contractJsonSchemas()).length).toBeGreaterThan(0);
  });
});
