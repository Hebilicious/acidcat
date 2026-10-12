# Toolchain

`acidcat`, the command-line tool for catalogs. It runs at build time, in CI, or by hand, and never in an application at runtime.

```sh
node toolchain/src/cli.ts check <catalog.json ...>            # validate, including canonical form
node toolchain/src/cli.ts format [--write] <catalog.json ...> # put a catalog in canonical form
node toolchain/src/cli.ts view <catalog.json> <target>        # print the view of one target
```

`check` applies [`schemas/catalog.schema.json`](../schemas/catalog.schema.json) and every catalog rule the schema cannot express ([Conformance](../spec/conformance.md#catalog)), and requires the file to be in [canonical form](../spec/catalog.md#canonical-form). It exits 0 when every catalog conforms, 1 when one does not, and 2 for a usage error.

`format` is how a catalog that was not written by an SDK reaches canonical form: Pkl output, a code generator's output, or a file edited by hand.

| File | Holds |
| --- | --- |
| `src/catalog.ts` | The catalog rules, views and bundling |
| `src/cli.ts` | The command line |
| `test/` | Tests, run by `moon run toolchain` |

The canonical writer itself lives in [`sdk/typescript/src/canonical.ts`](../sdk/typescript/src/canonical.ts), which the toolchain imports, so TypeScript has exactly one.
