# @acid-cat/spec-ts

`@acid-cat/spec-ts` holds the fixed details of the [AcidCat specification](../../spec/README.md) as TypeScript data and pure functions. It has no dependencies.

The package is part of the TypeScript reference implementation. [`@acid-cat/core-effect`](../core-effect) and [`@acid-cat/core-ts`](../core-ts) both use it, so the two cores agree on every detail. An implementation in another language does not use it.

```sh
pnpm add @acid-cat/spec-ts
```

```ts
import { callFailure, fail, isCallFailure, ok } from "@acid-cat/spec-ts";

const outcomes = [ok({ power: true }), fail({ _tag: "Offline" }), callFailure("unavailable", "The unit does not answer.")];

for (const outcome of outcomes) {
  if (isCallFailure(outcome)) console.log(`call failure: ${outcome.kind}`);
  else if (outcome.ok) console.log("value", outcome.value);
  else console.log("failure", outcome.error._tag);
}
```

## Exports

| Export | Use |
| --- | --- |
| `ok`, `fail`, `callFailure`, `isCallFailure` | Make and test [outcomes](../../spec/invocation.md#outcomes). `fail` takes the whole failure: `fail({ _tag: "Offline", since })` |
| `isJsonObject` | Tell whether a value is a JSON object: not `null` and not an array |
| `CALL_FAILURE_KINDS`, `CallFailureError` | The call failure kinds, and the JavaScript error for one call failure |
| `AVAILABLE`, `unavailable` | Make [availability](../../spec/invocation.md#availability) values |
| `targetCatalog`, `bundle` | A target's [catalog](../../spec/catalog.md#the-catalog-of-a-target), and a schema together with its shared types |
| `resolveType` | The type that a schema's `$ref` points to, whatever other keys the schema has |
| `ownMember` | An object's member for a key, or `undefined`. Inherited names, such as `constructor`, are not members |
| `mcpToolAnnotations` | A capability's MCP `annotations`: `readOnlyHint` from `readOnly`, plus `destructiveHint` and `idempotentHint` from `destructive` and `idempotent` when the capability has them. See [Tools](../../spec/surfaces/mcp.md#tools) |
| `cliAliases`, `cliAliasOfArgs`, `cliAliasUsage` | Check a target's [aliases](../../spec/surfaces/cli.md#aliases), find the alias that the command-line arguments name, and write an alias's usage. See below |
| `byCodePoint` | Sort strings by Unicode code point, as the [canonical form](../../spec/catalog.md#canonical-form) sorts keys |

The remaining exports give each [surface](../../spec/surfaces/README.md)'s names, flags, exit codes and tool shapes.

### Aliases

- A command alias has one or two words. Its name can be a shared prefix, but not a command's path.
- `cliAliasOfArgs` takes the command paths. Arguments that start with a command's path name no alias.
- `cliAliasOfArgs` returns `{ unknownCommand }` for a word that names no command and no alias, when the word follows a prefix default or the one-word alias of a group.

## Generated facts

`src/facts.generated.ts` holds the constants that every core shares: the exit codes, the call failure kinds, the HTTP status of each kind, the reserved flags and the MCP constants.

`moon run model:generate` writes this file from [`model/facts.qnt`](../../model/facts.qnt), and writes the same facts into the Rust core. Do not edit the file by hand: change the model and generate again. `moon run verify` fails when the file differs from the model's output.
