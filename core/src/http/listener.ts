import type { IncomingMessage, ServerResponse } from "node:http";
import { coreFailure } from "@aacl/core-domain";
import { matchRoute, type RouteMatch } from "./router.ts";
import { errorResponse, responseForRoute, type HttpResponse } from "./responses.ts";
import type { Logger } from "../logging/logger.ts";

type RouteResolver = (
  method: string | undefined,
  target: string | undefined,
) => RouteMatch;

export type RequestListenerOptions = {
  readonly logger: Logger;
  /**
   * Defaults to the real router. It is overridable only so a test can force a throw:
   * `matchRoute` is total, so the exception boundary below has no other way to go red,
   * and an unguarded throw returns no response at all rather than a 500.
   */
  readonly routes?: RouteResolver;
};

export const createRequestListener = ({
  logger,
  routes = matchRoute,
}: RequestListenerOptions): ((req: IncomingMessage, res: ServerResponse) => void) => (
  req,
  res,
) => {
  let response: HttpResponse;
  try {
    response = responseForRoute(routes(req.method, req.url));
  } catch (error) {
    logger.log("error", "core.request_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    response = errorResponse(coreFailure("internal", "The request could not be processed."));
  }

  res.writeHead(response.status, response.headers);
  res.end(response.body);
};
