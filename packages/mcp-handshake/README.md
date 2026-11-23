# @acid-cat/mcp-handshake

`@acid-cat/mcp-handshake` lets an MCP server that speaks only revision `2026-07-28` also serve clients that open with the [`initialize` handshake of earlier revisions](../../spec/bindings/mcp.md#earlier-revisions-through-http) (`2025-11-25` and `2025-06-18`). Many MCP clients still use that handshake.

`mcpHandshake(handler)` wraps a web handler of the [MCP binding through HTTP](../../spec/bindings/mcp.md#http) and returns a new web handler. The wrapper keeps no state. It works in front of any web handler that serves revision `2026-07-28`.

The package is part of the TypeScript reference implementation. You usually get it through a core: [`@acid-cat/core-ts`](../core-ts) re-exports it as `mcpHandshake`, and [`@acid-cat/core-effect`](../core-effect) as `Mcp.withHandshake`.

```sh
pnpm add @acid-cat/mcp-handshake
```

## Use

With `@acid-cat/core-ts`:

```ts
import { mcpHandler, mcpHandshake } from "@acid-cat/core-ts";

const mcp = mcpHandshake(mcpHandler(app, options));
```

With `@acid-cat/core-effect`:

```ts
import { Mcp } from "@acid-cat/core-effect";

const mcp = Mcp.withHandshake(Mcp.toWebHandler(app, layer, options));
```

| Option | Default | Use |
| --- | --- | --- |
| `maximumBytes` | 1 MiB | The largest body that the wrapper reads. The wrapper passes a larger body to the handler unchanged, and the handler rejects it |

## How it works

- A request of revision `2026-07-28`, and any request that is not `POST`, goes to the handler unchanged.
- The wrapper turns each handshake request into a revision `2026-07-28` request for the handler: `tools/list` and `tools/call` pass as they are, and every other method becomes `server/discover`. The handler therefore still screens each request's origin, media type and size.
- Each request gets the [headers](../../spec/bindings/mcp.md#headers) that the handler checks: `Mcp-Method`, and for `tools/call` `Mcp-Name` and one `Mcp-Param-*` header for each argument whose property has `x-mcp-header`. To find these properties, the wrapper first asks the handler for `tools/list`, because it keeps no state.
- A response that is not 2xx comes back unchanged.
- `initialize` returns the result of `server/discover` in the handshake's shape. `ping` returns an empty result. A notification gets 202. Any other method gets the JSON-RPC error `-32601`.
- Results carry no `_meta`, `resultType`, `ttlMs` or `cacheScope` member. A JSON-RPC error has HTTP status 200.

Because the wrapper keeps no session, it never sends `notifications/tools/list_changed`, and it declares `"tools": { "listChanged": false }`. A client that needs to see tool changes must use revision `2026-07-28` or MCP through stdio.
