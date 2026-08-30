import * as z from "zod/mini";
import { describe, expect, it } from "vitest";
import { contractJsonSchemas, contractSchemas } from "../src/index.js";

const JSON_SCHEMA_DRAFT = "https://json-schema.org/draft/2020-12/schema";

describe("contract JSON Schemas", () => {
  it("renders every registered schema without unsupported types", () => {
    const renderedSchemas = contractJsonSchemas();

    for (const [name, schema] of Object.entries(contractSchemas)) {
      const rendered = renderedSchemas[name] as Record<string, unknown>;

      expect(rendered.$schema, name).toBe(JSON_SCHEMA_DRAFT);
      expect(rendered.additionalProperties, name).toBe(false);
      expect(() => z.toJSONSchema(schema)).not.toThrow();
    }
  });

  it("keeps input and output JSON Schema representations identical", () => {
    for (const [name, schema] of Object.entries(contractSchemas)) {
      expect(
        z.toJSONSchema(schema, { io: "input" }),
        name,
      ).toEqual(z.toJSONSchema(schema, { io: "output" }));
    }
  });
});
