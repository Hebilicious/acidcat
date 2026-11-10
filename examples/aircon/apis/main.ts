/**
 * Serve one of the APIs on http://127.0.0.1:3000, with a simulated unit. `serve` from `@acid-cat/core-ts/node` serves the
 * web handler of the API on Node.js. The GraphQL API also serves its subscriptions through WebSockets, on
 * ws://127.0.0.1:3001/graphql, and the Cap'n Web API serves its sessions through WebSockets on ws://127.0.0.1:3001/rpc.
 * The Elysia API runs on the Node.js adapter of Elysia, `@elysiajs/node`, which also serves its WebSocket
 * ws://127.0.0.1:3000/status/follow on the same port.
 *
 * Usage: node apis/main.ts graphql|capnweb|elysia|mcp
 */
import { once } from "node:events";

import { serve } from "@acid-cat/core-ts/node";
import { node } from "@elysiajs/node";
import { WebSocketServer } from "ws";

import { Unit } from "../core-ts/aircon.ts";
import { capnwebApi, capnwebWebSocket } from "./capnweb.ts";
import { elysiaApi } from "./elysia.ts";
import { graphqlApi, graphqlWebSocket } from "./graphql.ts";
import { mcpApi } from "./mcp.ts";

const unit = new Unit();
const apis = {
  graphql: () => ({ handler: graphqlApi({ unit }), paths: ["/graphql", "/api"] }),
  capnweb: () => ({ handler: capnwebApi({ unit }), paths: ["/rpc", "/api"] }),
  mcp: () => ({ handler: mcpApi().handler, paths: ["/mcp", "/capabilities/mcp", "/capabilities/mcp-legacy"] }),
};

const name = process.argv[2];
if (name !== "graphql" && name !== "capnweb" && name !== "elysia" && name !== "mcp") {
  console.error("Usage: node apis/main.ts graphql|capnweb|elysia|mcp");
  process.exit(2);
}
if (name === "elysia") {
  elysiaApi({ unit }, node()).listen({ hostname: "127.0.0.1", port: 3000 });
  console.log(["http://127.0.0.1:3000/status", "http://127.0.0.1:3000/api", "ws://127.0.0.1:3000/status/follow"].join("\n"));
} else {
  await serveApi(name);
}

async function serveApi(name: keyof typeof apis) {
  const { handler, paths } = apis[name]();
  const served = await serve(Object.fromEntries(paths.map((path) => [path, handler])));
  console.log(paths.map((path) => `${served.url}${path}`).join("\n"));
  if (name === "graphql") {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 3001, path: "/graphql" });
    await once(server, "listening");
    graphqlWebSocket({ unit }, server);
    console.log("ws://127.0.0.1:3001/graphql");
  }
  if (name === "capnweb") {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 3001, path: "/rpc" });
    await once(server, "listening");
    capnwebWebSocket({ unit }, server);
    console.log("ws://127.0.0.1:3001/rpc");
  }
}
