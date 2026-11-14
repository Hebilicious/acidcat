# @acid-cat/catalog

The AcidCat catalog library for TypeScript. npm package: `@acid-cat/catalog`.

Write a catalog in TypeScript, and write it in canonical form. The library has no dependencies. Use it at build time to write `acidcat.catalog.json`.

```sh
pnpm add -D @acid-cat/catalog
```

```ts
import { writeFile } from "node:fs/promises";

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
const book = catalog.type("Book", { type: "object", properties: { isbn: { type: "string" } } });
catalog.event("library.book.returned", {
  description: "A member returned a book. The occurrence gives the book.",
  audience: ["desk"],
  input: { type: "object", properties: {} },
  payload: book,
});

await writeFile("acidcat.catalog.json", catalog.render());
```

`event()` declares an [event](../../../spec/events.md): clients subscribe to it, and get its payload in each occurrence. A payload is an object, or a reference to a type that is an object. `validate()` lists the rules a catalog breaks, and `render()` refuses to render one that breaks any. The full example is [`examples/library.ts`](examples/library.ts), a lending library.

The tests compare the output of the library with files in this directory: the lending-library catalog [`examples/library.acidcat.json`](examples/library.acidcat.json), and a catalog of values that languages write differently, [`test/fixtures/edge.acidcat.json`](test/fixtures/edge.acidcat.json). The air-conditioner example of the repository also writes its catalog with this library, in [`examples/aircon/catalog/typescript.ts`](../../../examples/aircon/catalog/typescript.ts). Its test compares the output with the Pkl catalog. Each committed catalog file is in [canonical form](../../../spec/catalog.md#canonical-form), and the root `moon run check` checks this. Thus all catalog libraries agree on the canonical form, and they do not share a test file. Test with `moon run catalog-typescript:test`.
