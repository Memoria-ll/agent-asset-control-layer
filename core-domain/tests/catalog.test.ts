import { describe, expect, it } from "vitest";
import { parseExecutionTargetCatalog } from "../src/index.ts";

describe("execution target catalog document", () => {
  it("rejects an unsupported schema version with the incompatible contract vocabulary", () => {
    const result = parseExecutionTargetCatalog(JSON.stringify({
      schemaVersion: 2,
      providers: [],
      runtimes: [],
      models: [],
      roleModelRelations: [],
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("incompatible_contract");
      expect(result.failure.details?.[0]?.code).toBe("unsupported_schema_version");
    }
  });
});

