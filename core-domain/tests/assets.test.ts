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
schema-version: 3
operation: add
id: review-checklist
type: rule
tier: core
lifecycle: active
mandatory: true
priority: 0
merge-mode: exclusive
merge-group: review-checklist
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
schema-version: 3
id: review-checklist
type: rule
tier: core
operation: add
lifecycle: active
mandatory: true
priority: 0
merge-mode: exclusive
merge-group: review-checklist
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

const failurePath = (result: AssetResult<unknown>) => {
  expect(result.ok).toBe(false);
  if (result.ok) return undefined;
  return result.failure.details?.[0]?.path;
};

describe("canonical asset domain", () => {
  it("serializes the full-field document to the canonical golden", () => {
    const asset = parseAndValidate(fullDocument);
    const serialized = serializeCanonicalAsset(asset);

    expect(serialized).toEqual({ ok: true, value: goldenDocument });
  });

  it.each(["add", "override", "disable"] as const)("parses and round-trips operation %s", (operation) => {
    const asset = parseAndValidate(`---\nschema-version: 3\noperation: ${operation}\nid: operation-${operation}\ntype: rule\ntier: core\n---\nbody`);
    expect(asset.operation).toBe(operation);
    expect(serializeCanonicalAsset(asset)).toMatchObject({ ok: true, value: expect.stringContaining(`operation: ${operation}`) });
  });

  it("rejects missing, unknown, and list-valued operations", () => {
    const documents = [
      `---\nschema-version: 3\nid: missing-operation\ntype: rule\ntier: core\n---\nbody`,
      `---\nschema-version: 3\noperation: replace\nid: invalid-operation\ntype: rule\ntier: core\n---\nbody`,
      `---\nschema-version: 3\noperation: [add, disable]\nid: list-operation\ntype: rule\ntier: core\n---\nbody`,
    ];
    for (const document of documents) expect(failurePath(validateAsset(parseDocument(document)))).toEqual(["document", "frontmatter", "operation"]);
  });

  it("keeps omitted directives absent from the model and serialized document", () => {
    const asset = parseAndValidate(`---
schema-version: 3
operation: add
id: omitted-directives
type: rule
tier: core
---
body`);

    for (const field of ["mandatory", "priority", "mergeMode", "mergeGroup"]) {
      expect(Object.hasOwn(asset, field), field).toBe(false);
    }
    const serialized = serializeCanonicalAsset(asset);
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    expect(serialized.value).not.toMatch(/^(mandatory|priority|merge-mode|merge-group):/m);
    expect(parseAndValidate(serialized.value)).toEqual(asset);
  });

  it("distinguishes explicit directive values from omitted values through round-trip", () => {
    const asset = parseAndValidate(`---
schema-version: 3
operation: add
id: explicit-directives
type: rule
tier: core
mandatory: false
priority: 0
merge-mode: additive
---
body`);

    expect(asset.mandatory).toBe(false);
    expect(asset.priority).toBe(0);
    expect(asset.mergeMode).toBe("additive");
    expect(Object.hasOwn(asset, "mandatory")).toBe(true);
    expect(Object.hasOwn(asset, "priority")).toBe(true);
    expect(Object.hasOwn(asset, "mergeMode")).toBe(true);
    const serialized = serializeCanonicalAsset(asset);
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    expect(serialized.value).toContain("mandatory: false\npriority: 0\nmerge-mode: additive\n");
    expect(parseAndValidate(serialized.value)).toEqual(asset);
  });

  it("normalizes scope and requires in the model while preserving metadata list order", () => {
    const document = `---
id: normalized-asset
type: skill
schema-version: 3
operation: add
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
schema-version: 3
operation: add
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
schema-version: 3
operation: add
tier: on-demand
metadata.author: colon: # quote " value
---
body
---
tail`);
    const withTerminal = parseAndValidate(`---
id: literal-body
type: knowledge
schema-version: 3
operation: add
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
schema-version: 3
operation: add
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
schema-version: 3
operation: add
tier: core
requires: [a,,b]
---
`);
    expect(failureCodes(malformedList)).toEqual(["invalid_list"]);

    const invalidType = validateAsset(parseDocument(`---
id: invalid-type
type: unknown
schema-version: 3
operation: add
tier: core
---
`));
    expect(failureCodes(invalidType)).toContain("invalid_value");

    const invalidIdResult = validateAsset(parseDocument(`---
id: Invalid_ID
type: rule
schema-version: 3
operation: add
tier: core
---
`));
    expect(failureCodes(invalidIdResult)).toContain("invalid_asset_id");

    const missing = validateAsset(parseDocument(`---
schema-version: 3
operation: add
type: rule
---
`));
    expect(failureCodes(missing)).toEqual(["missing_field", "missing_field"]);

    const empty = validateAsset(parseDocument(`---
id: empty-list
type: rule
schema-version: 3
operation: add
tier: core
scope.role: []
---
`));
    expect(failureCodes(empty)).toContain("empty_list");

    const duplicate = validateAsset(parseDocument(`---
id: duplicate-list
type: rule
schema-version: 3
operation: add
tier: core
requires: [same-id, same-id]
---
`));
    expect(failureCodes(duplicate)).toContain("duplicate_value");

    const unknown = validateAsset(parseDocument(`---
id: unknown-key
type: rule
schema-version: 3
operation: add
tier: core
priority: high
---
    `));
    expect(failureCodes(unknown)).toEqual(["invalid_value"]);

    const unknownKey = validateAsset(parseDocument(`---
schema-version: 3
operation: add
id: unknown-key
type: rule
tier: core
overrides: [other-asset]
---
`));
    expect(failureCodes(unknownKey)).toEqual(["unknown_key"]);
    expect(failurePath(unknownKey)).toEqual(["document", "frontmatter", "overrides"]);

    const unsupported = validateAsset(parseDocument(`---
schema-version: 4
operation: add
id: future-schema
type: rule
tier: core
---
`));
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) expect(unsupported.failure.code).toBe("incompatible_contract");
    expect(failureCodes(unsupported)).toEqual(["unsupported_schema_version"]);
  });

  it("rejects legacy and missing schema versions with incompatible contract details", () => {
    for (const document of [
      `---
schema-version: 2
operation: add
id: previous-schema
type: rule
tier: core
---
`,
      `---
schema-version: 1
operation: add
id: legacy-schema
type: rule
tier: core
---
`,
      `---
operation: add
id: missing-schema
type: rule
tier: core
---
`,
    ]) {
      const result = validateAsset(parseDocument(document));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.code).toBe("incompatible_contract");
      expect(failureCodes(result)).toEqual(["unsupported_schema_version"]);
      expect(failurePath(result)).toEqual(["document", "frontmatter", "schema-version"]);
    }
  });

  it("reports directive value errors with their frontmatter paths", () => {
    const invalidValues = [
      ["mandatory: [true]", "mandatory"],
      ["mandatory: TRUE", "mandatory"],
      ["priority: -1", "priority"],
      ["priority: 01", "priority"],
      ["priority: 1.5", "priority"],
      ["priority: 9007199254740992", "priority"],
      ["merge-mode: layered", "merge-mode"],
      ["merge-group: [review]", "merge-group"],
      ["merge-group: a:b", "merge-group"],
    ] as const;

    for (const [line, key] of invalidValues) {
      const result = validateAsset(parseDocument(`---
schema-version: 3
operation: add
id: invalid-directive
type: rule
tier: core
${line}
---
`));
      expect(failureCodes(result), line).toEqual(["invalid_value"]);
      expect(failurePath(result), line).toEqual(["document", "frontmatter", key]);
    }

    const missingMergeGroup = validateAsset(parseDocument(`---
schema-version: 3
operation: add
id: missing-merge-group
type: rule
tier: core
merge-mode: exclusive
---
`));
    expect(failureCodes(missingMergeGroup)).toEqual(["invalid_merge_group"]);
    expect(failurePath(missingMergeGroup)).toEqual(["document", "frontmatter", "merge-group"]);
  });

  it("runtime-validates directives before serializing", () => {
    const base = parseAndValidate(`---
schema-version: 3
operation: add
id: runtime-directive
type: rule
tier: core
---
body`);
    const invalidPriority = serializeCanonicalAsset({ ...base, priority: -1 });
    expect(invalidPriority.ok).toBe(false);
    if (!invalidPriority.ok) expect(invalidPriority.failure.code).toBe("invalid_request");
    const invalidMandatory = serializeCanonicalAsset({ ...base, mandatory: "true" as unknown as boolean });
    expect(invalidMandatory.ok).toBe(false);
    if (!invalidMandatory.ok) expect(invalidMandatory.failure.code).toBe("invalid_request");
    const missingMergeGroup = serializeCanonicalAsset({ ...base, mergeMode: "exclusive" });
    expect(failureCodes(missingMergeGroup)).toEqual(["invalid_merge_group"]);
    const invalidOperation = serializeCanonicalAsset({ ...base, operation: "replace" as never });
    expect(failureCodes(invalidOperation)).toEqual(["invalid_value"]);
  });

  it("rejects duplicate keys and aggregates independent syntax details in source order", () => {
    const result = parseAssetDocument(`---
schema-version: 3
operation: add
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
      `---\nid: property-empty\ntype: rule\nschema-version: 3\noperation: add\ntier: core\nmetadata.author: comma, scalar\n---\n`,
      `\uFEFF---\r\nid: property-one\r\ntype: skill\r\nschema-version: 3\r\noperation: add\r\ntier: discoverable\r\nrequires: [one-requirement]\r\nmetadata.tags: [one-tag]\r\n---\r\nbody`,
      `---\nid: property-many\ntype: knowledge\nschema-version: 3\noperation: add\ntier: on-demand\nscope.project: [project-b, project-a]\nrequires: [requirement-b, requirement-a]\nmetadata.tags: [first, second]\n---\nbody\n`,
    ];

    for (const document of documents) {
      const asset = parseAndValidate(document);
      const serialized = serializeCanonicalAsset(asset);
      expect(serialized.ok).toBe(true);
      if (!serialized.ok) continue;
      expect(serialized.value).toContain("operation: add\n");
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
