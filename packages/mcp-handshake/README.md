# @acid-cat/mcp-handshake

The [`initialize` handshake of earlier MCP revisions](../../spec/bindings/mcp.md#earlier-revisions-through-http) in front of an MCP server through HTTP. npm package: `@acid-cat/mcp-handshake`.

An MCP server of the [MCP binding](../../spec/bindings/mcp.md#http) through HTTP serves revision `2026-07-28`. Many MCP clients open the session with the `initialize` handshake of revision `2025-11-25` or `2025-06-18`. `mcpHandshake(handler)` gives a web handler that serves these clients too. It keeps no state.

This package is part of the TypeScript reference implementation. [`@acid-cat/core-ts`](../core-ts) gives it as `mcpHandshake`, and [`@acid-cat/core-effect`](../core-effect) gives it as `Mcp.withHandshake`. It works in front of any web handler that serves MCP revision `2026-07-28`.

```sh
pnpm add @acid-cat/mcp-handshake
```

## Use

```ts
import { mcpHandler, mcpHandshake } from "@acid-cat/core-ts";

const mcp = mcpHandshake(mcpHandler(app, options));
```

```ts
import { Mcp } from "@acid-cat/core-effect";

const mcp = Mcp.withHandshake(Mcp.toWebHandler(app, layer, options));
```

| Option | Default | Use |
| --- | --- | --- |
| `maximumBytes` | 1 MiB | The longest body that the wrapper reads. The wrapper sends a longer body to the handler unchanged, and the handler rejects it |

## How it works

- A request of revision `2026-07-28`, and a request that is not `POST`, go to the handler unchanged.
- The wrapper sends each request of a handshake to the handler as a request of revision `2026-07-28`: `tools/list` and `tools/call` as they are, and each other method as `server/discover`. So the handler screens the origin, the media type and the size of each request.
- A response that is not 2xx comes back unchanged.
- `initialize` gives the result of `server/discover` in the form of the handshake. `ping` gives an empty result. A notification gets 202. Another method gets the JSON-RPC error `-32601`.
- A result has no `_meta`, `resultType`, `ttlMs` or `cacheScope` member. A JSON-RPC error has the HTTP status 200.

The wrapper keeps no session, so it does not send `notifications/tools/list_changed`. Its capabilities are `"tools": { "listChanged": false }`. A client that must see the changes of the tools uses revision `2026-07-28`, or MCP through stdio.
