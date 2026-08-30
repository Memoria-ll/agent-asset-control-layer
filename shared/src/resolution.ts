import * as z from "zod/mini";
import { DirectoryPath } from "./primitives.js";
import {
  LoadingTier,
  ResolutionScopeInput,
  ResolvedContextDto,
} from "./resolved-context.js";
import { tryParseWith, type ParseOutcome } from "./errors.js";

/**
 * What the IDE knows about the current editing situation, collected explicitly
 * by the extension and passed in.
 *
 * Repository and branch metadata are not fields here: they are not resolution
 * axes. Neither is the editor selection — its content is file body text, and a
 * field carrying body text across the boundary needs the protected-file
 * question (#36) answered first.
 */
export const IdeContextInput = z.strictObject({
  workspaceFolder: z.optional(DirectoryPath),
  activeFilePath: z.optional(DirectoryPath),
  selectedFilePaths: z.optional(z.array(DirectoryPath)),
});
export type IdeContextInput = z.infer<typeof IdeContextInput>;

/**
 * A request to resolve the asset context for a scope.
 *
 * It carries no contract version: versions are matched once when the connection
 * is established (#32), and a per-request copy would be a second place to keep
 * that agreement in step.
 */
export const ResolveRequest = z.strictObject({
  scope: ResolutionScopeInput,
  ide: z.optional(IdeContextInput),
  loadingTiers: z.optional(z.array(LoadingTier)),
});
export type ResolveRequest = z.infer<typeof ResolveRequest>;
export type ResolveRequestInput = z.input<typeof ResolveRequest>;

/**
 * The envelope around a resolved context, so that response-level metadata can
 * be added later as optional fields without reshaping the context itself.
 */
export const ResolveResponse = z.strictObject({
  resolvedContext: ResolvedContextDto,
});
export type ResolveResponse = z.infer<typeof ResolveResponse>;
export type ResolveResponseInput = z.input<typeof ResolveResponse>;

export const parseResolveRequest = (value: unknown): ResolveRequest =>
  z.parse(ResolveRequest, value);

export const tryParseResolveRequest = (
  value: unknown,
): ParseOutcome<ResolveRequest> => tryParseWith(ResolveRequest, value);

export const parseResolveResponse = (value: unknown): ResolveResponse =>
  z.parse(ResolveResponse, value);

export const tryParseResolveResponse = (
  value: unknown,
): ParseOutcome<ResolveResponse> => tryParseWith(ResolveResponse, value);
