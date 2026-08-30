import * as z from "zod/mini";
import { describe, expect, it } from "vitest";
import { contractJsonSchemas } from "../src/index.js";
// The registry is internal to the package; only its JSON form is published.
import { contractSchemas } from "../src/json-schema.js";

const JSON_SCHEMA_DRAFT = "https://json-schema.org/draft/2020-12/schema";

/**
 * The object nodes a rendered schema forbids unknown keys on.
 *
 * A union renders as `oneOf` and carries `additionalProperties` on each arm
 * rather than at the root, so reading only the root would silently stop checking
 * the constraint the moment a DTO becomes a union.
 */
const strictObjectNodes = (
  rendered: Record<string, unknown>,
): Record<string, unknown>[] =>
  Array.isArray(rendered.oneOf)
    ? (rendered.oneOf as Record<string, unknown>[])
    : [rendered];

describe("contract JSON Schemas", () => {
  it("renders every registered schema without unsupported types", () => {
    const renderedSchemas = contractJsonSchemas();

    for (const [name, schema] of Object.entries(contractSchemas)) {
      const rendered = renderedSchemas[name] as Record<string, unknown>;
      const nodes = strictObjectNodes(rendered);

      expect(rendered.$schema, name).toBe(JSON_SCHEMA_DRAFT);
      expect(nodes.length, name).toBeGreaterThan(0);
      for (const [index, node] of nodes.entries()) {
        expect(node.additionalProperties, `${name}[${index}]`).toBe(false);
      }
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
