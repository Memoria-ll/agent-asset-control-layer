import { describe, expect, it } from "vitest";
import * as shared from "../src/index.ts";
import { contractJsonSchemas } from "../src/index.ts";

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
   * dependency is what enforces the boundary instead of a reviewer noticing. So
   * no zod value may reach the index — not a schema, not a registry, not a
   * helper taking one.
   *
   * This is checked over the whole surface rather than against a list of names,
   * because a list only catches what a previous round happened to notice. Every
   * zod schema carries a `_zod` property, so the question "is this a zod value"
   * is answerable without importing zod here.
   */
  it("publishes no zod value", () => {
    const zodValued = Object.entries(shared).filter(
      ([, value]) =>
        typeof value === "object" && value !== null && "_zod" in value,
    );

    expect(zodValued.map(([name]) => name)).toEqual([]);
  });

  it("publishes only types, functions and plain data", () => {
    const unexpected = Object.entries(shared).filter(([, value]) => {
      if (typeof value === "function" || typeof value === "string") return false;
      // The closed value sets are plain arrays of strings.
      return !(Array.isArray(value) && value.every((v) => typeof v === "string"));
    });

    expect(unexpected.map(([name]) => name)).toEqual([]);
  });

  it("publishes the JSON form of the schemas", () => {
    expect(Object.keys(contractJsonSchemas()).length).toBeGreaterThan(0);
  });
});
