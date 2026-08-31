import { createServer } from "node:http";
import { coreFailure, type CoreFailure } from "@aacl/core-domain";
import { createRequestListener } from "./http/listener.ts";
import type { Logger } from "./logging/logger.ts";
import { resolveCoreSettings, type CoreEnv } from "./config/settings.ts";

export type StartOutcome =
  | {
      readonly ok: true;
      readonly address: { readonly host: string; readonly port: number };
      readonly close: () => Promise<void>;
    }
  | { readonly ok: false; readonly failure: CoreFailure };

const errorCodeOf = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string") return code;
  }
  return "UNKNOWN";
};

export const startCore = async (options: {
  readonly env: CoreEnv;
  readonly logger: Logger;
}): Promise<StartOutcome> => {
  const settings = resolveCoreSettings(options.env);
  if (!settings.ok) return settings;

  const server = createServer(createRequestListener({ logger: options.logger }));
  const listenResult = await new Promise<StartOutcome>((resolve) => {
    let settled = false;

    // The error handler must be installed in the same synchronous turn as listen.
    server.once("error", (error: unknown) => {
      if (settled) return;
      settled = true;
      const code = errorCodeOf(error);
      resolve({
        ok: false,
        failure: coreFailure(
          "unavailable",
          `Core could not listen on ${settings.settings.host}:${settings.settings.port}; code ${code}.`,
        ),
      });
    });

    server.listen(settings.settings.port, settings.settings.host, () => {
      if (settled) return;
      settled = true;
      const address = server.address();
      if (address === null || typeof address === "string") {
        // This TCP listen call cannot produce a non-TCP address, so this branch has no red test seam.
        resolve({
          ok: false,
          failure: coreFailure(
            "internal",
            "Core started without a TCP address.",
          ),
        });
        return;
      }

      let closePromise: Promise<void> | undefined;
      const close = (): Promise<void> => {
        if (closePromise !== undefined) return closePromise;
        server.closeAllConnections();
        closePromise = new Promise<void>((resolveClose, rejectClose) => {
          server.close((error?: Error) => {
            if (error !== undefined) {
              rejectClose(error);
              return;
            }
            resolveClose();
          });
        });
        return closePromise;
      };

      resolve({
        ok: true,
        address: { host: address.address, port: address.port },
        close,
      });
    });
  });

  return listenResult;
};

export { createFilesystemAssetStore } from "./assets/filesystem-store.ts";
export type {
  AssetDiagnostic,
  AssetListResult,
  AssetLocation,
  AssetLookupResult,
  AssetStore,
  ManagedAssetRoot,
  SaveAssetInput,
  StoredAsset,
  StoredAssetSource,
} from "./assets/filesystem-store.ts";
