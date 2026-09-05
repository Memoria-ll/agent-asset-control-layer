import {
  createWorkflowEntryReference,
  type MetadataCatalog,
  type WorkflowEntryReference,
} from "@aacl/core-domain";
import type { WorkflowId } from "@aacl/shared";
import type { StoredAssetSource } from "../assets/filesystem-store.ts";
import type { WorkflowDefinitionLoadResult } from "./filesystem-definition-loader.ts";
import { loadWorkflowDefinition } from "./filesystem-definition-loader.ts";
import type { AssetStore } from "../assets/filesystem-store.ts";

export type WorkflowEntryLoadResult =
  | {
      readonly ok: true;
      readonly entry: WorkflowEntryReference;
      readonly source: StoredAssetSource;
      readonly assetDiagnostics: Extract<WorkflowDefinitionLoadResult, { readonly ok: true }>["assetDiagnostics"];
    }
  | Extract<WorkflowDefinitionLoadResult, { readonly ok: false }>;

export const loadWorkflowEntryReference = async (
  assetStore: AssetStore,
  workflowId: WorkflowId,
  catalog: MetadataCatalog,
): Promise<WorkflowEntryLoadResult> => {
  const loaded = await loadWorkflowDefinition(assetStore, workflowId, catalog);
  if (!loaded.ok) return loaded;
  return {
    ok: true,
    entry: createWorkflowEntryReference(loaded.definition.workflowId, loaded.revision),
    source: loaded.source,
    assetDiagnostics: loaded.assetDiagnostics,
  };
};
