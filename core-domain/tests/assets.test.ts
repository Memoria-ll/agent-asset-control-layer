import { describe, expect, it } from "vitest";
import { ASSET_TYPES, LOADING_TIERS } from "@aacl/shared";
import {
  asAssetId,
  parseAssetDocument,
  serializeCanonicalAsset,
  validateAsset,
  type AssetResult,
  type AssetFieldValue,
  type CanonicalAsset,
} from "../src/index.ts";

const fullDocument = `---
schema-version: 1
id: review-checklist
type: rule
tier: core
lifecycle: active
scope.project: [project-two, project-one]
scope.workflow: [review-flow]
scope.stage: [review]
scope.task-type: [implementation]
scope.role: [reviewer]
scope.provider: [anthropic]
scope.runtime: [claude-code]
scope.model: [sol]
scope.directory: [/workspace/src, /workspace]
requires: [safety-rule, naming-convention]
metadata.author: Jane Doe
metadata.tags: [Doe, John]
---
# Review checklist

- inspect`;

const goldenDocument = `---
schema-version: 1
id: review-checklist
type: rule
tier: core
lifecycle: active
scope.project: [project-one, project-two]
scope.workflow: [review-flow]
scope.stage: [review]
scope.task-type: [implementation]
scope.role: [reviewer]
scope.provider: [anthropic]
scope.runtime: [claude-code]
scope.model: [sol]
scope.directory: [/workspace, /workspace/src]
requires: [naming-convention, safety-rule]
metadata.author: Jane Doe
metadata.tags: [Doe, John]
---
# Review checklist

- inspect`;

const parseAndValidate = (document: string): CanonicalAsset => {
  const parsed = parseDocument(document);
  const validated = validateAsset(parsed);
  expect(validated.ok).toBe(true);
  if (!validated.ok) throw new Error(validated.failure.message);
  return validated.value;
};

const parseDocument = (document: string) => {
  const parsed = parseAssetDocument(document);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.failure.message);
  return parsed.value;
};

const failureCodes = (result: AssetResult<unknown>) => {
  expect(result.ok).toBe(false);
  if (result.ok) return [];
  return result.failure.details?.map((item) => item.code) ?? [];
};

describe("canonical asset domain", () => {
  it("serializes the full-field document to the canonical golden", () => {
    const asset = parseAndValidate(fullDocument);
    const serialized = serializeCanonicalAsset(asset);

    expect(serialized).toEqual({ ok: true, value: goldenDocument });
  });

  it("normalizes scope and requires in the model while preserving metadata list order", () => {
    const document = `---
id: normalized-asset
type: skill
tier: discoverable
scope.role: [z-role, a-role]
scope.model: [z-model, a-model]
requires: [z-requirement, a-requirement]
metadata.tags: [John, Doe]
---
body`;
    const asset = parseAndValidate(document);

    expect(asset.scope.role).toEqual(["a-role", "z-role"]);
    expect(asset.scope.model).toEqual(["a-model", "z-model"]);
    expect(asset.requires).toEqual(["a-requirement", "z-requirement"]);
    expect(asset.metadata.tags).toEqual(["John", "Doe"]);
  });

  it("normalizes BOM, CRLF, and mixed line endings without changing the model", () => {
    const lf = parseAndValidate(fullDocument);
    const mixed = `\uFEFF${fullDocument.replace(/\n/g, "\r\n").replace("scope.role: [reviewer]\r\n", "scope.role: [reviewer]\n")}`;

    expect(parseAndValidate(mixed)).toEqual(lf);
    expect(serializeCanonicalAsset(parseAndValidate(mixed))).toEqual({ ok: true, value: goldenDocument });
  });

  it("distinguishes a metadata list from a scalar containing a comma", () => {
    const asset = parseAndValidate(`---
id: comma-values
type: rule
tier: core
metadata.tags: [Doe, John]
metadata.author: Doe, John
---
`);

    expect(asset.metadata.tags).toEqual(["Doe", "John"]);
    expect(asset.metadata.author).toBe("Doe, John");
  });

  it("preserves body literals and terminal newline state", () => {
    const withoutTerminal = parseAndValidate(`---
id: literal-body
type: knowledge
tier: on-demand
metadata.author: colon: # quote " value
---
body
---
tail`);
    const withTerminal = parseAndValidate(`---
id: literal-body
type: knowledge
tier: on-demand
metadata.author: colon: # quote " value
---
body
---
tail
`);

    expect(withoutTerminal.body).toBe("body\n---\ntail");
    expect(withTerminal.body).toBe("body\n---\ntail\n");
    expect(serializeCanonicalAsset(withoutTerminal)).not.toEqual(serializeCanonicalAsset(withTerminal));
  });

  it("accepts every shared asset type and loading tier", () => {
    for (const type of ASSET_TYPES) {
      for (const tier of LOADING_TIERS) {
        const asset = parseAndValidate(`---
id: all-members-${type.replace(/-/g, "")}-${tier.replace(/-/g, "")}
type: ${type}
tier: ${tier}
---
`);
        expect(asset.type).toBe(type);
        expect(asset.tier).toBe(tier);
      }
    }
  });

  it("reports invalid parser and validator inputs with the specified vocabulary", () => {
    const malformedList = parseAssetDocument(`---
id: malformed-list
type: rule
tier: core
requires: [a,,b]
---
`);
    expect(failureCodes(malformedList)).toEqual(["invalid_list"]);

    const invalidType = validateAsset(parseDocument(`---
id: invalid-type
type: unknown
tier: core
---
`));
    expect(failureCodes(invalidType)).toContain("invalid_value");

    const invalidIdResult = validateAsset(parseDocument(`---
id: Invalid_ID
type: rule
tier: core
---
`));
    expect(failureCodes(invalidIdResult)).toContain("invalid_asset_id");

    const missing = validateAsset(parseDocument(`---
type: rule
---
`));
    expect(failureCodes(missing)).toEqual(["missing_field", "missing_field"]);

    const empty = validateAsset(parseDocument(`---
id: empty-list
type: rule
tier: core
scope.role: []
---
`));
    expect(failureCodes(empty)).toContain("empty_list");

    const duplicate = validateAsset(parseDocument(`---
id: duplicate-list
type: rule
tier: core
requires: [same-id, same-id]
---
`));
    expect(failureCodes(duplicate)).toContain("duplicate_value");

    const unknown = validateAsset(parseDocument(`---
id: unknown-key
type: rule
tier: core
priority: high
---
`));
    expect(failureCodes(unknown)).toEqual(["unknown_key"]);

    const unsupported = validateAsset(parseDocument(`---
schema-version: 2
id: future-schema
type: rule
tier: core
---
`));
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) expect(unsupported.failure.code).toBe("incompatible_contract");
    expect(failureCodes(unsupported)).toEqual(["unsupported_schema_version"]);
  });

  it("rejects duplicate keys and aggregates independent syntax details in source order", () => {
    const result = parseAssetDocument(`---
id:
bad line
type: rule
id:
tier:
id: later-id
---
`);

    expect(failureCodes(result)).toEqual(["empty_scalar", "invalid_line", "duplicate_key", "empty_scalar", "duplicate_key"]);
  });

  it("uses one asset-id casting seam for valid and invalid ids", () => {
    const valid = asAssetId("valid-asset-2");
    expect(valid).toEqual({ ok: true, value: "valid-asset-2" });

    for (const value of ["", "Upper", "two--hyphens", "leading-", "a_b", "a.b", "a/b", "a "]) {
      const invalid = asAssetId(value);
      expect(failureCodes(invalid)).toEqual(["invalid_asset_id"]);
    }
  });

  it("round-trips deterministic boundary values and rejects unrepresentable values", () => {
    const documents = [
      `---\nid: property-empty\ntype: rule\ntier: core\nmetadata.author: comma, scalar\n---\n`,
      `\uFEFF---\r\nid: property-one\r\ntype: skill\r\ntier: discoverable\r\nrequires: [one-requirement]\r\nmetadata.tags: [one-tag]\r\n---\r\nbody`,
      `---\nid: property-many\ntype: knowledge\ntier: on-demand\nscope.project: [project-b, project-a]\nrequires: [requirement-b, requirement-a]\nmetadata.tags: [first, second]\n---\nbody\n`,
    ];

    for (const document of documents) {
      const asset = parseAndValidate(document);
      const serialized = serializeCanonicalAsset(asset);
      expect(serialized.ok).toBe(true);
      if (!serialized.ok) continue;
      expect(serialized.value).toContain("schema-version: 1\n");
      const reparsed = parseAndValidate(serialized.value);
      expect(reparsed).toEqual(asset);
    }

    const base = parseAndValidate(documents[2] ?? "");
    const unrepresentable: Array<{ field: string; value: AssetFieldValue }> = [
      { field: "metadata.bad-scalar", value: " leading" },
      { field: "metadata.bad-bracket", value: "[starts-list]" },
      { field: "metadata.bad-newline", value: "line\nbreak" },
      { field: "metadata.bad-list-comma", value: ["contains,comma"] },
      { field: "metadata.bad-list-bracket", value: ["contains[bracket"] },
      { field: "metadata.bad-list-newline", value: ["line\nbreak"] },
    ];
    for (const { field, value } of unrepresentable) {
      const metadata = { ...base.metadata, [field.slice("metadata.".length)]: value };
      const result = serializeCanonicalAsset({ ...base, metadata });
      expect(result.ok, field).toBe(false);
    }
  });
});
