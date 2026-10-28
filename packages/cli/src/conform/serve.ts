/**
 * Serve web request handlers, `(request: Request) => Promise<Response>`, on a free local port. Implementations use it
 * to run `acid-cat conform` against their bindings in a test.
 */
import { serve as serveOnNode } from "@acid-cat/spec-ts/node";
import type { Routes, Served, WebHandler } from "@acid-cat/spec-ts/node";

export type { Routes, Served, WebHandler } from "@acid-cat/spec-ts/node";

/** Serve handlers by path prefix, for example `{ "/mcp": mcp, "/api": http }`, on `127.0.0.1` and a free port. */
export function serve(routes: WebHandler | Routes): Promise<Served> {
  return serveOnNode(routes, { port: 0 });
}
