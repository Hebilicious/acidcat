# APIs on the air conditioner

The HTTP binding gives generic access to the capabilities: one route for each id, with the outcome as JSON. An API whose design you control is application code. Build it on a session of the [TypeScript binding](../../spec/bindings/typescript.md), with the library that you prefer, and serve the HTTP binding beside it.

These examples build three APIs on the air conditioner of [`@acid-cat/core-ts`](../../packages/core-ts/examples/aircon.ts). Each one serves the HTTP binding at `/api` and rejects origins that it does not allow.

| File | Library | API | Failures |
| --- | --- | --- | --- |
| [`src/graphql.ts`](src/graphql.ts) | [Pothos](https://pothos-graphql.dev) and [GraphQL Yoga](https://the-guild.dev/graphql/yoga-server) | `query { status }`, and mutations that return the new status | A GraphQL error with the tag or the kind as `code` |
| [`src/capnweb.ts`](src/capnweb.ts) | [Cap'n Web](https://github.com/cloudflare/capnweb) | A class with typed methods. A client sends many calls in one request | A result value: `{ ok: false, error }` |
| [`src/elysia.ts`](src/elysia.ts) | [Elysia](https://elysiajs.com) | `GET /status`, and `PATCH /status` that changes many settings. The HTTP binding is mounted with `.mount("/api", …)` | Status 409 with the failure |

[`src/aircon.ts`](src/aircon.ts) has what they share: the session, the HTTP binding, and a call that gives the value of a capability.

Each API calls the capabilities through their handles. Thus the capabilities validate their input, and the API gets the same outcomes as all other surfaces.

## Run

```sh
node src/main.ts graphql   # or capnweb, elysia
moon run example-apis:test
```
