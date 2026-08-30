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
});
