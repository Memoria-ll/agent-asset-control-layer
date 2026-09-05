import { createServer } from "node:http";
import { coreFailure, type CoreFailure } from "@aacl/core-domain";
import { createRequestListener } from "./http/listener.ts";
import type { Logger } from "./logging/logger.ts";
import { resolveCoreSettings, type CoreEnv } from "./config/settings.ts";
import {
  createProjectRegistry,
  defaultProjectRegistryPath,
  type ProjectRegistryOptions,
} from "./projects/registry.ts";

export type StartFailureStage = "settings" | "project-registry" | "listen";

export type StartOutcome =
  | {
      readonly ok: true;
      readonly address: { readonly host: string; readonly port: number };
      readonly close: () => Promise<void>;
    }
  | { readonly ok: false; readonly stage: StartFailureStage; readonly failure: CoreFailure };

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
  readonly projectRegistryPath?: string;
  readonly projectRegistryOptions?: ProjectRegistryOptions;
}): Promise<StartOutcome> => {
  const settings = resolveCoreSettings(options.env);
  if (!settings.ok) return { ok: false, stage: "settings", failure: settings.failure };

  const registry = createProjectRegistry(
    options.projectRegistryPath ?? defaultProjectRegistryPath(),
    options.projectRegistryOptions,
  );
  const reconciled = await registry.reconcile();
  if (!reconciled.ok) return { ok: false, stage: "project-registry", failure: reconciled.failure };
  if (reconciled.value.status === "degraded") {
    options.logger.log("warn", "core.project_registry_reconcile_degraded", {
      reason: reconciled.value.reason,
    });
  }

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
        stage: "listen",
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
          stage: "listen",
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

export {
  loadSkill,
  projectStoredSkillCandidate,
  saveSkill,
  updateSkill,
} from "./assets/filesystem-skill-store.ts";
export type {
  SaveSkillInput,
  SkillLoadResult,
  StoredSkill,
} from "./assets/filesystem-skill-store.ts";
export { toResolutionSnapshot } from "./assets/resolution-input.ts";
export type { ResolutionInputProjection } from "./assets/resolution-input.ts";

export { loadMetadataCatalog } from "./catalog/filesystem-catalog.ts";
export type {
  MetadataCatalogLoadResult,
  MetadataCatalogSource,
} from "./catalog/filesystem-catalog.ts";

export { loadWorkflowDefinition } from "./workflow/filesystem-definition-loader.ts";
export type { WorkflowDefinitionLoadResult } from "./workflow/filesystem-definition-loader.ts";

export { loadWorkflowEntryReference } from "./workflow/filesystem-entry-loader.ts";
export type { WorkflowEntryLoadResult } from "./workflow/filesystem-entry-loader.ts";

export { createWorkflowStateStore } from "./workflow/filesystem-state-store.ts";
export type {
  WorkflowStateStore,
  WorkflowStateStoreOptions,
} from "./workflow/filesystem-state-store.ts";

export { createProjectService } from "./projects/service.ts";
export type {
  ProjectService,
  ProjectServiceOptions,
} from "./projects/service.ts";

export {
  createProjectRegistry,
  defaultProjectRegistryPath,
} from "./projects/registry.ts";
export type {
  ProjectRegistry,
  RegistryObservation,
} from "./projects/registry.ts";
