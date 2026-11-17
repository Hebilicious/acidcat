# @acid-cat/spec-ts

The fixed details of the [AcidCat specification](../../spec/README.md), as TypeScript data and pure functions. npm package: `@acid-cat/spec-ts`. It has no dependencies.

This package is part of the TypeScript reference implementation. [`@acid-cat/core-effect`](../core-effect) and [`@acid-cat/core-ts`](../core-ts) use it, so that both cores agree on each detail. An implementation in another language does not use it.

The constants that each core shares, such as the exit codes, the call failure kinds, the HTTP status of each kind, the reserved flags and the MCP constants, are in `src/facts.generated.ts`. `moon run model:generate` writes this file from [`model/facts.qnt`](../../model/facts.qnt), and writes the same facts into the Rust core. Do not change the file by hand: change the model, and write the file again. `moon run verify` fails when the file is not the output of the model.

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
| `resolveType` | The type that the `$ref` of a schema refers to, whatever other keys the schema has |
| `ownMember` | The member of an object with a key, or `undefined`. Inherited names, such as `constructor`, are not members |
| `byCodePoint` | Order strings by Unicode code point, as the [canonical form](../../spec/catalog.md#canonical-form) sorts keys |

The other exports give the names, flags, exit codes and tool shapes of each [binding](../../spec/bindings/README.md).
