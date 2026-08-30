export type RouteMatch =
  | { readonly kind: "health" }
  | { readonly kind: "method-not-allowed" }
  | { readonly kind: "not-found" };

export const matchRoute = (
  method: string | undefined,
  target: string | undefined,
): RouteMatch => {
  if (method === undefined || target === undefined) return { kind: "not-found" };

  const queryIndex = target.indexOf("?");
  // URL parsing normalizes absolute-form and malformed targets, which breaks exact routing.
  const path = queryIndex === -1 ? target : target.slice(0, queryIndex);

  if (path !== "/health") return { kind: "not-found" };
  if (method === "GET" || method === "HEAD") return { kind: "health" };
  return { kind: "method-not-allowed" };
};
