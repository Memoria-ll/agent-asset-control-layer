import { describe, expect, it } from "vitest";
import {
  parseAssetDocument,
  parseBindingAsset,
  parseBindingDocument,
  serializeCanonicalAsset,
  validateAsset,
  type AssetResult,
  type CanonicalAsset,
} from "../src/index.ts";

const unwrap = <Value>(result: AssetResult<Value>): Value => {
  if (!result.ok) throw new Error(result.failure.message);
  return result.value;
};

const bindingDocument = (id: string, metadata: string, body = "description"): string => `---
schema-version: 3
id: ${id}
type: binding
tier: core
operation: add
${metadata}---
${body}`;

const parseCanonical = (source: string): CanonicalAsset =>
  unwrap(validateAsset(unwrap(parseAssetDocument(source))));

describe("binding asset contract", () => {
  it.each([
    ["provider", "metadata.target-kind: provider\nmetadata.provider-id: openai\n"],
    ["runtime", "metadata.target-kind: runtime\nmetadata.runtime-id: codex\n"],
    ["model", "metadata.target-kind: model\nmetadata.model-id: gpt-5\n"],
    ["runtime-model", "metadata.target-kind: runtime-model\nmetadata.runtime-id: codex\nmetadata.model-id: gpt-5\n"],
  ])("parses %s target metadata", (_kind, metadata) => {
    const binding = unwrap(parseBindingAsset(parseCanonical(bindingDocument("binding-target", metadata))));
    expect(binding.target).toMatchObject({ kind: _kind });
    expect(binding.description).toBe("description");
  });

  it("preserves scope, fallback ID, and body through the real asset parser path", () => {
    const binding = unwrap(parseBindingDocument(bindingDocument(
      "reviewer-fallback",
      "scope.role: [reviewer]\nmetadata.target-kind: model\nmetadata.model-id: fallback-model\nmetadata.fallback-for: reviewer-primary\n",
      "fallback explanation\n",
    )));

    expect(binding.bindingId).toBe("reviewer-fallback");
    expect(binding.fallbackFor).toBe("reviewer-primary");
    expect(binding.asset.scope.role).toEqual(["reviewer"]);
    expect(binding.description).toBe("fallback explanation\n");
    expect(serializeCanonicalAsset(binding.asset)).toMatchObject({ ok: true });
  });

  it("rejects unknown metadata and impossible target combinations", () => {
    const unknown = parseBindingAsset(parseCanonical(bindingDocument(
      "unknown-metadata",
      "metadata.target-kind: model\nmetadata.model-id: gpt-5\nmetadata.owner: team\n",
    )));
    const impossible = parseBindingAsset(parseCanonical(bindingDocument(
      "impossible-target",
      "metadata.target-kind: provider\nmetadata.provider-id: openai\nmetadata.model-id: gpt-5\n",
    )));

    expect(unknown).toMatchObject({ ok: false, failure: { details: [{ code: "unknown_metadata" }] } });
    expect(impossible).toMatchObject({ ok: false, failure: { details: [{ code: "invalid_target_fields" }] } });
  });

  it("allows a disabled binding to retain body but rejects target metadata", () => {
    const disabled = parseCanonical(`---
schema-version: 3
id: disabled-binding
type: binding
tier: core
operation: disable
---
disabled explanation`);
    const parsed = unwrap(parseBindingAsset(disabled));
    expect(parsed.description).toBe("disabled explanation");
    expect(parsed.target).toBeUndefined();

    const invalid = parseBindingAsset(parseCanonical(`---
schema-version: 3
id: disabled-binding
type: binding
tier: core
operation: disable
metadata.target-kind: model
metadata.model-id: gpt-5
---
`));
    expect(invalid).toMatchObject({ ok: false, failure: { details: [{ code: "disable_target_metadata" }] } });
  });
});
