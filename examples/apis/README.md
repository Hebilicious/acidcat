# APIs on the air conditioner

The HTTP and MCP bindings give generic access to the capabilities: one route or one tool for each id. An API whose design you control is application code. Build it on a session, with the library that you prefer, and serve a binding beside it.

Three examples build APIs on the air conditioner of [`@acid-cat/core-ts`](../../packages/core-ts/examples/aircon.ts). Each one serves the HTTP binding at `/api`. The fourth example builds an MCP server on the air conditioner of [`@acid-cat/core-effect`](../../packages/core-effect/examples/aircon.ts), fully in Effect. It serves the MCP binding at `/capabilities/mcp`. All examples reject origins that they do not allow.

| File | Library | API | Failures |
| --- | --- | --- | --- |
| [`src/graphql.ts`](src/graphql.ts) | [Pothos](https://pothos-graphql.dev) and [GraphQL Yoga](https://the-guild.dev/graphql/yoga-server) | `query { status }`, and mutations that return the new status | A GraphQL error with the tag or the kind as `code` |
| [`src/capnweb.ts`](src/capnweb.ts) | [Cap'n Web](https://github.com/cloudflare/capnweb) | A class with typed methods. A client sends many calls in one request | A result value: `{ ok: false, error }` |
| [`src/elysia.ts`](src/elysia.ts) | [Elysia](https://elysiajs.com) | `GET /status`, and `PATCH /status` that changes many settings. The HTTP binding is mounted with `.mount("/api", …)` | Status 409 with the failure |
| [`src/mcp.ts`](src/mcp.ts) | [Effect](https://effect.website) `effect/ai` | MCP tools `get_status` and `set_controls`, which changes many settings in one call. The tools make typed calls with `session.execute` | A tool error with the failure |

[`src/aircon.ts`](src/aircon.ts) has what the three APIs on `@acid-cat/core-ts` share: the session, the HTTP binding, and a call that gives the value of a capability.

Each API calls the capabilities through a session. Thus it gets the same outcomes as all other surfaces. The three APIs on `@acid-cat/core-ts` give input that is not trusted to the handles, and the handles validate it. The MCP server validates the parameters of its tools with Effect Schema, then makes typed calls.

## Run

```sh
node src/main.ts graphql   # or capnweb, elysia, mcp
moon run example-apis:test
```
