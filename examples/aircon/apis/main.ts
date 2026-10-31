/**
 * Serve one of the APIs on http://127.0.0.1:3000, with a simulated unit. `serve` from `@acid-cat/core-ts/node` serves the
 * web handler of the API on Node.js.
 *
 * Usage: node apis/main.ts graphql|capnweb|elysia|mcp
 */
import { serve } from "@acid-cat/core-ts/node";

import { Unit } from "../core-ts/aircon.ts";
import { capnwebApi } from "./capnweb.ts";
import { elysiaApi } from "./elysia.ts";
import { graphqlApi } from "./graphql.ts";
import { mcpApi } from "./mcp.ts";

const unit = new Unit();
const apis = {
  graphql: () => ({ handler: graphqlApi({ unit }), paths: ["/graphql", "/api"] }),
  capnweb: () => ({ handler: capnwebApi({ unit }), paths: ["/rpc", "/api"] }),
  elysia: () => {
    const app = elysiaApi({ unit });
    return { handler: async (request: Request) => app.handle(request), paths: ["/status", "/api"] };
  },
  mcp: () => ({ handler: mcpApi().handler, paths: ["/mcp", "/capabilities/mcp", "/capabilities/mcp-handshake"] }),
};

const name = process.argv[2];
if (name !== "graphql" && name !== "capnweb" && name !== "elysia" && name !== "mcp") {
  console.error("Usage: node apis/main.ts graphql|capnweb|elysia|mcp");
  process.exit(2);
}
const { handler, paths } = apis[name]();
const served = await serve(Object.fromEntries(paths.map((path) => [path, handler])));
console.log(paths.map((path) => `${served.url}${path}`).join("\n"));
