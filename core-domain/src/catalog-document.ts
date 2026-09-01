import type { ProviderId, RuntimeId, ModelId, RoleId } from "@aacl/shared";
import { coreFailure, type AssetResult } from "./failures.ts";
import type {
  ModelDefinition,
  ProviderDefinition,
  RoleModelRelation,
  RuntimeDefinition,
} from "./catalog.ts";

/** The structurally validated JSON document consumed by the #3 resolver and #8 policy. */
export type ExecutionTargetCatalogDocument = {
  readonly schemaVersion: 1;
  readonly providers: readonly ProviderDefinition[];
  readonly runtimes: readonly RuntimeDefinition[];
  readonly models: readonly ModelDefinition[];
  readonly roleModelRelations: readonly RoleModelRelation[];
};

type Detail = {
  readonly path: string[];
  readonly code: string;
  readonly message: string;
};

const detail = (
  path: readonly string[],
  code: string,
  message: string,
): Detail => ({ path: [...path], code, message });

const failure = (
  code: "invalid_request" | "incompatible_contract",
  message: string,
  details: readonly Detail[],
): AssetResult<never> => ({
  ok: false,
  failure: coreFailure(code, message, details),
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const readString = (
  value: Record<string, unknown>,
  path: readonly string[],
  key: string,
  details: Detail[],
): string | undefined => {
  if (!hasOwn(value, key)) {
    details.push(detail([...path, key], "missing_field", `Required field "${key}" is missing.`));
    return undefined;
  }
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.length === 0) {
    details.push(detail([...path, key], "invalid_value", `Field "${key}" must be a non-empty string.`));
    return undefined;
  }
  return candidate;
};

const checkUnknownKeys = (
  value: Record<string, unknown>,
  path: readonly string[],
  allowed: readonly string[],
  details: Detail[],
): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      details.push(detail([...path, key], "unknown_key", `Unknown catalog key "${key}".`));
    }
  }
};

const parseDefinitions = <T>(
  value: unknown,
  name: "providers" | "runtimes" | "models" | "roleModelRelations",
  keys: readonly string[],
  build: (entry: Record<string, unknown>, path: readonly string[], details: Detail[]) => T | undefined,
  details: Detail[],
): T[] => {
  const result: T[] = [];
  if (!Array.isArray(value)) return result;
  for (const [index, item] of value.entries()) {
    const path = ["catalog", name, String(index)];
    if (!isObject(item)) {
      details.push(detail(path, "invalid_value", "Catalog entries must be objects."));
      continue;
    }
    checkUnknownKeys(item, path, keys, details);
    const parsed = build(item, path, details);
    if (parsed !== undefined) result.push(parsed);
  }
  return result;
};

/** Parse and structurally validate the JSON execution-target catalog consumed by #5/#12. */
export const parseExecutionTargetCatalog = (
  source: string,
): AssetResult<ExecutionTargetCatalogDocument> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    return failure("invalid_request", "The execution-target catalog is not valid JSON.", [
      detail(["catalog"], "invalid_json", "The execution-target catalog is not valid JSON."),
    ]);
  }

  if (!isObject(parsed)) {
    return failure("invalid_request", "The execution-target catalog must be an object.", [
      detail(["catalog"], "invalid_value", "The execution-target catalog must be an object."),
    ]);
  }

  if (!hasOwn(parsed, "schemaVersion")) {
    return failure("invalid_request", "The execution-target catalog is missing schemaVersion.", [
      detail(["catalog", "schemaVersion"], "missing_field", 'Required field "schemaVersion" is missing.'),
    ]);
  }
  const schemaVersion = parsed.schemaVersion;
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion)) {
    return failure("invalid_request", "The catalog schemaVersion must be an integer.", [
      detail(["catalog", "schemaVersion"], "invalid_value", "The catalog schemaVersion must be an integer."),
    ]);
  }
  if (schemaVersion !== 1) {
    return failure("incompatible_contract", `Catalog schemaVersion "${schemaVersion}" is not supported.`, [
      detail(["catalog", "schemaVersion"], "unsupported_schema_version", `Catalog schemaVersion "${schemaVersion}" is not supported.`),
    ]);
  }

  const details: Detail[] = [];
  checkUnknownKeys(
    parsed,
    ["catalog"],
    ["schemaVersion", "providers", "runtimes", "models", "roleModelRelations"],
    details,
  );
  const arrays = ["providers", "runtimes", "models", "roleModelRelations"] as const;
  for (const name of arrays) {
    if (!hasOwn(parsed, name)) {
      details.push(detail(["catalog", name], "missing_field", `Required field "${name}" is missing.`));
    } else if (!Array.isArray(parsed[name])) {
      details.push(detail(["catalog", name], "invalid_value", `Field "${name}" must be an array.`));
    }
  }

  const providers = parseDefinitions(
    parsed.providers,
    "providers",
    ["providerId", "displayName"],
    (entry, path, entryDetails) => {
      const providerId = readString(entry, path, "providerId", entryDetails);
      const displayName = readString(entry, path, "displayName", entryDetails);
      return providerId === undefined || displayName === undefined
        ? undefined
        : { providerId: providerId as ProviderId, displayName };
    },
    details,
  );
  const runtimes = parseDefinitions(
    parsed.runtimes,
    "runtimes",
    ["runtimeId", "displayName", "providerId"],
    (entry, path, entryDetails) => {
      const runtimeId = readString(entry, path, "runtimeId", entryDetails);
      const displayName = readString(entry, path, "displayName", entryDetails);
      const providerId = readString(entry, path, "providerId", entryDetails);
      return runtimeId === undefined || displayName === undefined || providerId === undefined
        ? undefined
        : { runtimeId: runtimeId as RuntimeId, displayName, providerId: providerId as ProviderId };
    },
    details,
  );
  const models = parseDefinitions(
    parsed.models,
    "models",
    ["modelId", "displayName", "providerId"],
    (entry, path, entryDetails) => {
      const modelId = readString(entry, path, "modelId", entryDetails);
      const displayName = readString(entry, path, "displayName", entryDetails);
      const providerId = readString(entry, path, "providerId", entryDetails);
      return modelId === undefined || displayName === undefined || providerId === undefined
        ? undefined
        : { modelId: modelId as ModelId, displayName, providerId: providerId as ProviderId };
    },
    details,
  );
  const roleModelRelations = parseDefinitions(
    parsed.roleModelRelations,
    "roleModelRelations",
    ["roleId", "modelId"],
    (entry, path, entryDetails) => {
      const roleId = readString(entry, path, "roleId", entryDetails);
      const modelId = readString(entry, path, "modelId", entryDetails);
      return roleId === undefined || modelId === undefined
        ? undefined
        : { roleId: roleId as RoleId, modelId: modelId as ModelId };
    },
    details,
  );

  if (details.length > 0) {
    return failure("invalid_request", "The execution-target catalog is structurally invalid.", details);
  }
  return {
    ok: true,
    value: { schemaVersion: 1, providers, runtimes, models, roleModelRelations },
  };
};
