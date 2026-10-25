# @acid-cat/catalog

The AcidCat catalog library for TypeScript. npm package: `@acid-cat/catalog`.

Write a catalog in TypeScript, and write it in canonical form. The library has no dependencies. Use it at build time to write `acidcat.catalog.json`.

```sh
pnpm add -D @acid-cat/catalog
```

```ts
import { Catalog } from "@acid-cat/catalog";

const catalog = new Catalog({ title: "Neighbourhood lending library" });
catalog.target("desk", { bindings: ["cli"] });
const notFound = catalog.type("NotFound", { type: "object" });
catalog.capability("library.loan.return", {
  description: "Take a book back from a member.",
  audience: ["desk"],
  input: { type: "object", required: ["loan"], properties: { loan: { type: "string" } } },
  failures: { NotFound: notFound },
});

await writeFile("acidcat.catalog.json", catalog.render());
```

`validate()` lists the rules a catalog breaks, and `render()` refuses to render one that breaks any. The full example is [`examples/library.ts`](examples/library.ts), a lending library.

The tests compare the output of the library with files in this directory: the lending-library catalog [`examples/library.acidcat.json`](examples/library.acidcat.json), and a catalog of values that languages write differently, [`test/fixtures/edge.acidcat.json`](test/fixtures/edge.acidcat.json). A test also compares [`examples/aircon.ts`](examples/aircon.ts) with the air-conditioner catalog of the repository. Each committed catalog file is in [canonical form](../../../spec/catalog.md#canonical-form), and the root `moon run check` checks this. Thus all catalog libraries agree on the canonical form, and they do not share a test file. Test with `moon run catalog-typescript:test`.
