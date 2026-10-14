# @acid-cat/spec-ts

The fixed details of the [AcidCat specification](../../spec/README.md), as TypeScript data and pure functions. npm package: `@acid-cat/spec-ts`. It has no dependencies.

This package is part of the TypeScript reference implementation. [`@acid-cat/core-effect`](../core-effect) and [`@acid-cat/core-ts`](../core-ts) use it, so that both cores agree on each detail. An implementation in another language does not use it.

```sh
pnpm add @acid-cat/spec-ts
```

## Contents

| Export | Use |
| --- | --- |
| `ok`, `fail`, `callFailure`, `isCallFailure` | Make and test [outcomes](../../spec/invocation.md#outcomes) |
| `CALL_FAILURE_KINDS`, `CallFailureError` | The kinds of call failure, and the JavaScript error for one |
| `AVAILABLE`, `unavailable` | Make [availability](../../spec/invocation.md#availability) values |
| `viewOf`, `bundle` | The [view](../../spec/catalog.md#views) of a target, and a schema with its shared types |

The other exports give the names, flags, exit codes and tool shapes of each [binding](../../spec/bindings/README.md).
