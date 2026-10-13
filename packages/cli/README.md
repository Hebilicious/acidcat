# @acid-cat/cli

The AcidCat command line. npm package: `@acid-cat/cli`. It gives the `acid-cat` command. Use it at build time, in CI or by hand. Do not use it in an application at run time.

```sh
acid-cat check [--strict] <catalog.json ...>  # check catalogs
acid-cat format [--write] <catalog.json ...>  # write catalogs in canonical form
acid-cat view <catalog.json> <target>         # write the view of one target
```

In this repository, run `pnpm exec acid-cat …`.

## check

`check` tests a catalog against [`schemas/catalog.schema.json`](../../schemas/catalog.schema.json) and against the [catalog rules](../../spec/conformance.md#catalog) that the schema cannot express.

- An **error** is a broken rule. Example: an audience that names an unknown target.
- A **warning** is a broken recommendation. Examples: a file that is not in [canonical form](../../spec/catalog.md#canonical-form), or a member with no `x-` prefix.

The exit code is 0 if there are no errors. It is 1 if there are errors. With `--strict`, warnings also give the exit code 1.

## format

`format` writes a catalog in canonical form. Use it for catalogs that a catalog library did not write: Pkl output, generated files, or files that you edit by hand.

## Implementation

The command line is an [Effect](https://effect.website) program that uses `effect/cli`. It validates catalogs with Effect Schema. It imports `schemas/catalog.schema.json` and each schema in the catalog as Effect schemas.

| File | Contents |
| --- | --- |
| `src/catalog.ts` | The catalog rules, views and bundling |
| `src/main.ts` | The commands |
| `test/` | Tests. Run them with `moon run cli:test` |

The canonical writer comes from [`@acid-cat/catalog`](../catalog/typescript).
