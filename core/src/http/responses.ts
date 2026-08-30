import {
  CONTRACT_VERSION,
  type CoreErrorCode,
} from "@aacl/shared";
import { coreFailure, toCoreErrorDto, type CoreFailure } from "@aacl/core-domain";
import type { RouteMatch } from "./router.ts";

export type HttpResponse = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
};

/**
 * Every code is mapped so that a `Record<CoreErrorCode, number>` fails to compile when
 * `CORE_ERROR_CODES` grows, which is what removes the need for a "not found, so 500"
 * fallback that would swallow the new value silently.
 */
export const STATUS_BY_CODE: Record<CoreErrorCode, number> = {
  invalid_request: 400,
  not_found: 404,
  internal: 500,
  // Not produced by any response path yet; #12 settles what these mean over HTTP.
  conflict: 409,
  unavailable: 503,
  incompatible_contract: 409,
};

const JSON_HEADERS = { "content-type": "application/json" } as const;

export const healthResponse = (): HttpResponse => ({
  status: 200,
  headers: JSON_HEADERS,
  body: JSON.stringify({ contractVersion: CONTRACT_VERSION }),
});

export type ErrorResponseOverrides = {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
};

export const errorResponse = (
  failure: CoreFailure,
  overrides?: ErrorResponseOverrides,
): HttpResponse => ({
  status: overrides?.status ?? STATUS_BY_CODE[failure.code],
  headers: { ...JSON_HEADERS, ...(overrides?.headers ?? {}) },
  body: JSON.stringify(toCoreErrorDto(failure)),
});

export const responseForRoute = (route: RouteMatch): HttpResponse => {
  switch (route.kind) {
    case "health":
      return healthResponse();
    case "method-not-allowed":
      return errorResponse(
        coreFailure("invalid_request", "The requested method is not allowed."),
        { status: 405, headers: { allow: "GET, HEAD" } },
      );
    case "not-found":
      return errorResponse(coreFailure("not_found", "No route matches this request."));
  }
};
