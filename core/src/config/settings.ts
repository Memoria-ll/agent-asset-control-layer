import { coreFailure, type CoreFailure } from "@aacl/core-domain";

export type CoreEnv = Readonly<Record<string, string | undefined>>;

export type CoreSettings = {
  readonly host: string;
  /** Port zero asks the operating system to select an available port. */
  readonly port: number;
};

export type SettingsResolution =
  | { readonly ok: true; readonly settings: CoreSettings }
  | { readonly ok: false; readonly failure: CoreFailure };

export const CORE_SETTINGS_DEFAULTS: CoreSettings = {
  host: "127.0.0.1",
  port: 7420,
};

export const CORE_ENV_KEYS = {
  host: "AACL_CORE_HOST",
  port: "AACL_CORE_PORT",
} as const;

// Core has no authentication, so a host outside loopback is rejected rather than bound.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const PORT_PATTERN = /^(0|[1-9][0-9]{0,4})$/;

export const resolveCoreSettings = (env: CoreEnv): SettingsResolution => {
  const hostValue = env[CORE_ENV_KEYS.host];
  const portValue = env[CORE_ENV_KEYS.port];

  if (hostValue !== undefined && !LOOPBACK_HOSTS.has(hostValue)) {
    return {
      ok: false,
      failure: coreFailure(
        "invalid_request",
        `${CORE_ENV_KEYS.host} must be one of 127.0.0.1, localhost, or ::1; received ${JSON.stringify(hostValue)}.`,
      ),
    };
  }

  let port: number;
  if (portValue === undefined) {
    port = CORE_SETTINGS_DEFAULTS.port;
  } else if (!PORT_PATTERN.test(portValue)) {
    return {
      ok: false,
      failure: coreFailure(
        "invalid_request",
        `${CORE_ENV_KEYS.port} must be an integer from 0 to 65535; received ${JSON.stringify(portValue)}.`,
      ),
    };
  } else {
    port = Number(portValue);
    if (port > 65535) {
      return {
        ok: false,
        failure: coreFailure(
          "invalid_request",
          `${CORE_ENV_KEYS.port} must be an integer from 0 to 65535; received ${JSON.stringify(portValue)}.`,
        ),
      };
    }
  }

  const host = hostValue ?? CORE_SETTINGS_DEFAULTS.host;
  return { ok: true, settings: { host, port } };
};
