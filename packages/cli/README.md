# @acid-cat/cli

The AcidCat command line, published to npm as `@acid-cat/cli`, which installs the `acid-cat` command. It runs at build time, in CI, or by hand, and never inside an application at runtime.

```sh
acid-cat check <catalog.json ...>            # validate, including canonical form
acid-cat format [--write] <catalog.json ...> # put a catalog in canonical form
acid-cat view <catalog.json> <target>        # print the view of one target
```

In this repository, run it with `pnpm exec acid-cat …`.

`check` applies [`schemas/catalog.schema.json`](../../schemas/catalog.schema.json) and every catalog rule the schema cannot express ([Conformance](../../spec/conformance.md#catalog)), and requires the file to be in [canonical form](../../spec/catalog.md#canonical-form). It exits 0 when every catalog conforms, 1 when one does not, and 2 for a usage error.

`format` is how a catalog that no catalog library wrote reaches canonical form: Pkl output, a code generator's output, or a file edited by hand.

`conform`, which runs the conformance tests against a running implementation, comes next (see [packages/README.md](../README.md#the-command-line)).

| File | Holds |
| --- | --- |
| `src/catalog.ts` | The catalog rules, views and bundling |
| `src/cli.ts` | The command line |
| `test/` | Tests, run by `moon run cli:test` |

The canonical writer comes from [`@acid-cat/catalog`](../catalog/typescript), so TypeScript has exactly one.
