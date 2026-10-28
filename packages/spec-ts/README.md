# @acid-cat/spec-ts

The fixed details of the [AcidCat specification](../../spec/README.md), as TypeScript data and pure functions. npm package: `@acid-cat/spec-ts`. It has no dependencies.

This package is part of the TypeScript reference implementation. [`@acid-cat/core-effect`](../core-effect) and [`@acid-cat/core-ts`](../core-ts) use it, so that both cores agree on each detail. An implementation in another language does not use it.

```sh
pnpm add @acid-cat/spec-ts
```

## Contents

| Export | Use |
| --- | --- |
| `ok`, `fail`, `callFailure`, `isCallFailure` | Make and test [outcomes](../../spec/invocation.md#outcomes). `fail` takes the whole failure: `fail({ _tag: "Offline", since })` |
| `isJsonObject` | Tell if a value is a JSON object: not `null`, and not an array |
| `CALL_FAILURE_KINDS`, `CallFailureError` | The kinds of call failure, and the JavaScript error for one |
| `AVAILABLE`, `unavailable` | Make [availability](../../spec/invocation.md#availability) values |
| `viewOf`, `bundle` | The [view](../../spec/catalog.md#views) of a target, and a schema with its shared types |

The other exports give the names, flags, exit codes and tool shapes of each [binding](../../spec/bindings/README.md).

## Serve on Node.js

`@acid-cat/spec-ts/node` needs Node.js. The main entry point works in all runtimes.

| Export | Use |
| --- | --- |
| `serve(handler, options)` | Serve web handlers, `(request: Request) => Promise<Response>`, on Node.js with only `node:http`. `handler` is one handler, or handlers by path prefix. `options.port` is `3000` by default, and `options.hostname` is `127.0.0.1` by default. The result has `url`, `port` and `close()`, and `await using` closes it |
| `WebHandler`, `Routes`, `ServeOptions`, `Served` | The types of `serve` |

The signal of a request aborts when the client closes the connection. A path that no prefix matches gets `404`. A handler that rejects gets `500`. Both cores export `serve` for their users: `@acid-cat/core-ts/node` and `NodeServer` in `@acid-cat/core-effect`.
