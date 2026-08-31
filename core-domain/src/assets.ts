import { ASSET_TYPES, LOADING_TIERS } from "@aacl/shared";
import type { AssetId, AssetType, LoadingTier } from "@aacl/shared";
import { coreFailure, type AssetResult } from "./failures.ts";

const ASSET_SCOPE_AXES = [
  "project",
  "workflow",
  "stage",
  "task-type",
  "role",
  "provider",
  "runtime",
  "model",
  "directory",
] as const;

export type AssetScopeAxis = (typeof ASSET_SCOPE_AXES)[number];
export type AssetFieldValue = string | readonly string[];

export type ParsedAssetDocument = {
  readonly fields: Readonly<Record<string, AssetFieldValue>>;
  readonly body: string;
};

export type CanonicalAsset = {
  readonly schemaVersion: 1;
  readonly id: AssetId;
  readonly type: AssetType;
  readonly tier: LoadingTier;
  readonly metadata: Readonly<Record<string, AssetFieldValue>>;
  readonly scope: Readonly<Partial<Record<AssetScopeAxis, readonly string[]>>>;
  readonly requires: readonly AssetId[];
  readonly lifecycle?: string;
  readonly body: string;
};

type Detail = {
  readonly path: string[];
  readonly code: string;
  readonly message: string;
};

const failure = (
  code: "invalid_request" | "incompatible_contract" | "internal",
  message: string,
  details: readonly Detail[],
): AssetResult<never> => ({
  ok: false,
  failure: coreFailure(code, message, details),
});

const detail = (
  path: readonly string[],
  code: string,
  message: string,
): Detail => ({ path: [...path], code, message });

const trimAscii = (value: string): string => value.replace(/^[ \t]+|[ \t]+$/g, "");

const isLowerKebabToken = (value: string): boolean =>
  value.length > 0 &&
  value.length <= 64 &&
  /^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value) &&
  !value.includes("--");

const isAssetScopeAxis = (value: string): value is AssetScopeAxis =>
  ASSET_SCOPE_AXES.includes(value as AssetScopeAxis);

const isAssetType = (value: string): value is AssetType =>
  ASSET_TYPES.includes(value as AssetType);

const isLoadingTier = (value: string): value is LoadingTier =>
  LOADING_TIERS.includes(value as LoadingTier);

const isAssetIdSyntax = (value: string): boolean =>
  /^(?!.*--)[a-z](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(value);

// A comma is always an element separator, so a list element cannot carry one. There is no
// quoting or escape form to add here: the grammar is exactly `key: scalar` and
// `key: [a, b]`, and a value that needs a comma is written as a scalar instead.
const parseListValue = (
  value: string,
  lineNumber: number,
  key: string,
): AssetResult<readonly string[]> => {
  if (!value.endsWith("]")) {
    return failure(
      "invalid_request",
      `Invalid list at line ${lineNumber}.`,
      [detail(["document", "frontmatter", key], "invalid_list", `Invalid list at line ${lineNumber}.`)],
    );
  }

  const inner = trimAscii(value.slice(1, -1));
  if (inner === "") return { ok: true, value: [] };

  const values = inner.split(",").map(trimAscii);
  if (values.some((item) => item === "" || item.includes("[") || item.includes("]"))) {
    return failure(
      "invalid_request",
      `Invalid list at line ${lineNumber}.`,
      [detail(["document", "frontmatter", key], "invalid_list", `Invalid list at line ${lineNumber}.`)],
    );
  }

  return { ok: true, value: values };
};

const parseFieldValue = (
  value: string,
  lineNumber: number,
  key: string,
): AssetResult<AssetFieldValue> => {
  const trimmed = trimAscii(value);
  if (trimmed === "") {
    return failure(
      "invalid_request",
      `Empty scalar at line ${lineNumber}.`,
      [detail(["document", "frontmatter", key], "empty_scalar", `Empty scalar at line ${lineNumber}.`)],
    );
  }

  if (trimmed.startsWith("[")) return parseListValue(trimmed, lineNumber, key);
  return { ok: true, value: trimmed };
};

export const parseAssetDocument = (source: string): AssetResult<ParsedAssetDocument> => {
  if (typeof source !== "string") {
    return failure("invalid_request", "Asset document must be a string.", [
      detail(["document"], "invalid_value", "Asset document must be a string."),
    ]);
  }

  if (/\r(?!\n)/.test(source)) {
    return failure("invalid_request", "Bare carriage returns are not valid line endings.", [
      detail(["document"], "invalid_line_ending", "Bare carriage returns are not valid line endings."),
    ]);
  }

  const withoutBom = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const lines = withoutBom.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") {
    return failure("invalid_request", "The asset document must start with a frontmatter delimiter.", [
      detail(["document"], "invalid_document_start", "The asset document must start with a frontmatter delimiter."),
    ]);
  }

  let endDelimiter = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === "---") {
      endDelimiter = index;
      break;
    }
  }
  if (endDelimiter < 0) {
    return failure("invalid_request", "The asset document has no closing frontmatter delimiter.", [
      detail(["document"], "missing_end_delimiter", "The asset document has no closing frontmatter delimiter."),
    ]);
  }

  const fields: Record<string, AssetFieldValue> = {};
  const seenKeys = new Set<string>();
  const details: Detail[] = [];
  const keyPattern = /^[a-z][a-z0-9-]{0,63}(?:\.[a-z][a-z0-9-]{0,63})*$/;

  for (let index = 1; index < endDelimiter; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const lineNumber = index + 1;
    const separator = line.indexOf(":");
    const key = separator < 0 ? "" : line.slice(0, separator);
    if (separator <= 0 || !keyPattern.test(key)) {
      details.push(detail(["document", "frontmatter"], "invalid_line", `Invalid frontmatter line ${lineNumber}.`));
      continue;
    }
    if (seenKeys.has(key)) {
      details.push(detail(["document", "frontmatter", key], "duplicate_key", `Duplicate key "${key}" at line ${lineNumber}.`));
      continue;
    }
    seenKeys.add(key);

    const parsedValue = parseFieldValue(line.slice(separator + 1), lineNumber, key);
    if (!parsedValue.ok) {
      details.push(...(parsedValue.failure.details ?? []));
      continue;
    }
    fields[key] = parsedValue.value;
  }

  if (details.length > 0) {
    return failure("invalid_request", "The asset document contains invalid frontmatter.", details);
  }

  return {
    ok: true,
    value: {
      fields,
      body: lines.slice(endDelimiter + 1).join("\n"),
    },
  };
};

const isStringList = (value: AssetFieldValue): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const hasDuplicates = (values: readonly string[]): boolean => new Set(values).size !== values.length;

const codeUnitCompare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const sortedValues = <Value extends string>(values: readonly Value[]): readonly Value[] =>
  [...values].sort(codeUnitCompare);

const validateList = (
  value: AssetFieldValue,
  key: string,
  details: Detail[],
): readonly string[] | undefined => {
  if (!isStringList(value)) {
    details.push(detail(["document", "frontmatter", key], "invalid_value", `Field "${key}" must be a list.`));
    return undefined;
  }
  if (value.length === 0) {
    details.push(detail(["document", "frontmatter", key], "empty_list", `Field "${key}" must not be empty.`));
  }
  if (hasDuplicates(value)) {
    details.push(detail(["document", "frontmatter", key], "duplicate_value", `Field "${key}" contains duplicate values.`));
  }
  return value;
};

const validateScalar = (
  value: AssetFieldValue,
  key: string,
  details: Detail[],
): string | undefined => {
  if (typeof value !== "string") {
    details.push(detail(["document", "frontmatter", key], "invalid_value", `Field "${key}" must be a scalar.`));
    return undefined;
  }
  return value;
};

export const asAssetId = (value: string): AssetResult<AssetId> => {
  if (typeof value !== "string" || !isAssetIdSyntax(value)) {
    return failure("invalid_request", "The asset id is invalid.", [
      detail(["document", "frontmatter", "id"], "invalid_asset_id", "The asset id must be a lowercase kebab token of 1 to 128 characters."),
    ]);
  }
  return { ok: true, value: value as AssetId };
};

export const validateAsset = (
  parsed: ParsedAssetDocument,
): AssetResult<CanonicalAsset> => {
  if (parsed === null || typeof parsed !== "object" || parsed.fields === null || typeof parsed.fields !== "object") {
    return failure("invalid_request", "The parsed asset document is invalid.", [
      detail(["document"], "invalid_value", "The parsed asset document is invalid."),
    ]);
  }

  const fields = parsed.fields;
  const details: Detail[] = [];
  let schemaVersion = 1 as 1;
  let id: AssetId | undefined;
  let type: AssetType | undefined;
  let tier: LoadingTier | undefined;
  let lifecycle: string | undefined;
  let requires: readonly AssetId[] = [];
  const metadata: Record<string, AssetFieldValue> = {};
  const scope: Partial<Record<AssetScopeAxis, readonly string[]>> = {};
  let unsupportedSchemaVersion = false;

  for (const [key, value] of Object.entries(fields)) {
    if (key === "schema-version") {
      const scalar = validateScalar(value, key, details);
      if (scalar === undefined) continue;
      if (!/^[1-9][0-9]*$/.test(scalar)) {
        details.push(detail(["document", "frontmatter", key], "invalid_value", `Schema version "${scalar}" is malformed.`));
      } else if (scalar !== "1") {
        unsupportedSchemaVersion = true;
        details.push(detail(["document", "frontmatter", key], "unsupported_schema_version", `Schema version "${scalar}" is not supported.`));
      }
      continue;
    }
    if (key === "id") {
      const scalar = validateScalar(value, key, details);
      if (scalar === undefined) continue;
      const result = asAssetId(scalar);
      if (!result.ok) details.push(...(result.failure.details ?? []));
      else id = result.value;
      continue;
    }
    if (key === "type") {
      const scalar = validateScalar(value, key, details);
      if (scalar !== undefined) {
        if (isAssetType(scalar)) type = scalar;
        else details.push(detail(["document", "frontmatter", key], "invalid_value", `Unknown asset type "${scalar}".`));
      }
      continue;
    }
    if (key === "tier") {
      const scalar = validateScalar(value, key, details);
      if (scalar !== undefined) {
        if (isLoadingTier(scalar)) tier = scalar;
        else details.push(detail(["document", "frontmatter", key], "invalid_value", `Unknown loading tier "${scalar}".`));
      }
      continue;
    }
    if (key === "lifecycle") {
      const scalar = validateScalar(value, key, details);
      if (scalar !== undefined) {
        if (isLowerKebabToken(scalar)) lifecycle = scalar;
        else details.push(detail(["document", "frontmatter", key], "invalid_value", `Lifecycle "${scalar}" is invalid.`));
      }
      continue;
    }
    if (key === "requires") {
      const values = validateList(value, key, details);
      if (values !== undefined) {
        const parsedIds: AssetId[] = [];
        for (const item of values) {
          const result = asAssetId(item);
          if (!result.ok) details.push(detail(["document", "frontmatter", key], "invalid_asset_id", `Required asset id "${item}" is invalid.`));
          else parsedIds.push(result.value);
        }
        requires = sortedValues(parsedIds);
      }
      continue;
    }
    if (key.startsWith("scope.")) {
      const axis = key.slice("scope.".length);
      if (!isAssetScopeAxis(axis)) {
        details.push(detail(["document", "frontmatter", key], "unknown_key", `Unknown scope key "${key}".`));
        continue;
      }
      const values = validateList(value, key, details);
      if (values !== undefined) scope[axis] = sortedValues(values);
      continue;
    }
    if (key.startsWith("metadata.")) {
      const name = key.slice("metadata.".length);
      if (!isLowerKebabToken(name)) {
        details.push(detail(["document", "frontmatter", key], "unknown_key", `Unknown metadata key "${key}".`));
        continue;
      }
      if (isStringList(value)) {
        if (value.length === 0) details.push(detail(["document", "frontmatter", key], "empty_list", `Field "${key}" must not be empty.`));
        if (hasDuplicates(value)) details.push(detail(["document", "frontmatter", key], "duplicate_value", `Field "${key}" contains duplicate values.`));
      } else if (typeof value !== "string") {
        details.push(detail(["document", "frontmatter", key], "invalid_value", `Field "${key}" has an invalid value.`));
      }
      metadata[name] = value;
      continue;
    }
    details.push(detail(["document", "frontmatter", key], "unknown_key", `Unknown asset key "${key}".`));
  }

  if (!Object.prototype.hasOwnProperty.call(fields, "id")) details.push(detail(["document", "frontmatter", "id"], "missing_field", 'Required field "id" is missing.'));
  if (!Object.prototype.hasOwnProperty.call(fields, "type")) details.push(detail(["document", "frontmatter", "type"], "missing_field", 'Required field "type" is missing.'));
  if (!Object.prototype.hasOwnProperty.call(fields, "tier")) details.push(detail(["document", "frontmatter", "tier"], "missing_field", 'Required field "tier" is missing.'));

  if (typeof parsed.body !== "string") details.push(detail(["document"], "invalid_value", "Asset body must be a string."));

  if (details.length > 0) {
    return failure(
      unsupportedSchemaVersion ? "incompatible_contract" : "invalid_request",
      unsupportedSchemaVersion ? "The asset schema version is not supported." : "The asset document contains invalid asset fields.",
      details,
    );
  }

  if (id === undefined || type === undefined || tier === undefined) {
    return failure("internal", "The validated asset is missing required fields.", [
      detail(["document"], "invalid_value", "The validated asset is missing required fields."),
    ]);
  }

  const model: {
    schemaVersion: 1;
    id: AssetId;
    type: AssetType;
    tier: LoadingTier;
    metadata: Readonly<Record<string, AssetFieldValue>>;
    scope: Readonly<Partial<Record<AssetScopeAxis, readonly string[]>>>;
    requires: readonly AssetId[];
    lifecycle?: string;
    body: string;
  } = {
    schemaVersion,
    id,
    type,
    tier,
    metadata,
    scope,
    requires,
    body: parsed.body,
  };
  if (lifecycle !== undefined) model.lifecycle = lifecycle;
  return { ok: true, value: model };
};

const serializationFailure = (message: string, code = "invalid_value"): AssetResult<never> =>
  failure("invalid_request", message, [detail(["document"], code, message)]);

const serializeFieldValue = (
  value: AssetFieldValue,
): AssetResult<string> => {
  if (typeof value === "string") {
    if (value === "" || trimAscii(value) !== value || value.startsWith("[") || /[\r\n]/.test(value)) {
      return serializationFailure("A scalar value cannot be represented by the asset grammar.");
    }
    return { ok: true, value };
  }
  if (!Array.isArray(value) || value.length === 0) {
    return serializationFailure("A list value must contain at least one element.", "empty_list");
  }
  for (const item of value) {
    if (typeof item !== "string" || item === "" || trimAscii(item) !== item || /[,\[\]\r\n]/.test(item)) {
      return serializationFailure("A list element cannot be represented by the asset grammar.", "invalid_list");
    }
  }
  return { ok: true, value: `[${value.join(", ")}]` };
};

const isSortedAndUnique = (values: readonly string[]): boolean =>
  values.every((value, index) => index === 0 || codeUnitCompare(values[index - 1] ?? "", value) < 0);

export const serializeCanonicalAsset = (
  asset: CanonicalAsset,
): AssetResult<string> => {
  if (asset === null || typeof asset !== "object") return serializationFailure("The canonical asset is invalid.");
  if (asset.schemaVersion !== 1) return serializationFailure("Only asset schema version 1 can be serialized.");
  const idResult = asAssetId(asset.id);
  if (!idResult.ok) return serializationFailure("The canonical asset id is invalid.", "invalid_asset_id");
  if (!isAssetType(asset.type) || !isLoadingTier(asset.tier)) return serializationFailure("The canonical asset type or tier is invalid.");
  if (typeof asset.body !== "string" || asset.body.includes("\r")) return serializationFailure("The canonical asset body is invalid.");
  if (asset.lifecycle !== undefined && (typeof asset.lifecycle !== "string" || !isLowerKebabToken(asset.lifecycle))) return serializationFailure("The canonical asset lifecycle is invalid.");
  if (asset.scope === null || typeof asset.scope !== "object") return serializationFailure("The canonical asset scope is invalid.");
  if (!Array.isArray(asset.requires) || !isSortedAndUnique(asset.requires)) return serializationFailure("The canonical asset requires list is not normalized.", "duplicate_value");

  for (const axis of Object.keys(asset.scope)) {
    if (!isAssetScopeAxis(axis)) return serializationFailure(`Scope key "${axis}" is invalid.`, "unknown_key");
  }

  for (const requiredId of asset.requires) {
    if (!asAssetId(requiredId).ok) return serializationFailure("The canonical asset requires list contains an invalid id.", "invalid_asset_id");
  }

  const lines: string[] = [];
  const append = (key: string, value: AssetFieldValue): AssetResult<undefined> => {
    const serialized = serializeFieldValue(value);
    if (!serialized.ok) return serialized;
    lines.push(`${key}: ${serialized.value}`);
    return { ok: true, value: undefined };
  };
  lines.push("---");
  if (!append("schema-version", "1").ok) return serializationFailure("The schema version cannot be serialized.");
  if (!append("id", asset.id).ok) return serializationFailure("The canonical asset id cannot be serialized.", "invalid_asset_id");
  if (!append("type", asset.type).ok || !append("tier", asset.tier).ok) return serializationFailure("The canonical asset type or tier cannot be serialized.");
  if (asset.lifecycle !== undefined && !append("lifecycle", asset.lifecycle).ok) return serializationFailure("The canonical asset lifecycle cannot be serialized.");

  for (const axis of ASSET_SCOPE_AXES) {
    const values = asset.scope[axis];
    if (values !== undefined) {
      if (!Array.isArray(values) || !isSortedAndUnique(values)) return serializationFailure(`The scope values for "${axis}" are not normalized.`, "duplicate_value");
      if (!append(`scope.${axis}`, values).ok) return serializationFailure(`The scope values for "${axis}" cannot be serialized.`, "invalid_list");
    }
  }
  if (asset.requires.length > 0 && !append("requires", asset.requires).ok) return serializationFailure("The requires list cannot be serialized.", "invalid_list");

  if (asset.metadata === null || typeof asset.metadata !== "object") return serializationFailure("The canonical asset metadata is invalid.");
  for (const name of Object.keys(asset.metadata).sort(codeUnitCompare)) {
    if (!isLowerKebabToken(name)) return serializationFailure(`Metadata key "${name}" is invalid.`, "unknown_key");
    const value = asset.metadata[name];
    if (value === undefined) return serializationFailure(`Metadata key "${name}" has no value.`);
    if (Array.isArray(value) && hasDuplicates(value)) return serializationFailure(`Metadata key "${name}" contains duplicate values.`, "duplicate_value");
    if (!append(`metadata.${name}`, value).ok) return serializationFailure(`Metadata key "${name}" cannot be serialized.`);
  }

  lines.push("---");
  return { ok: true, value: `${lines.join("\n")}\n${asset.body}` };
};
