# @acid-cat/catalog

The AcidCat catalog library for TypeScript, published on npm as `@acid-cat/catalog`. Build a catalog in code and write it in [canonical form](../../../spec/catalog.md#canonical-form). The library has no dependencies. Use it at build time to write `acidcat.catalog.json`.

## Install

```sh
pnpm add -D @acid-cat/catalog
```

## Example

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

The full example, a lending library, is [`examples/library.ts`](examples/library.ts).

## API

- `event()` declares an [event](../../../spec/events.md). Clients subscribe to it and get its payload in each occurrence. A payload is an object, or a reference to a type that is an object.
- `readOnly`, `destructive` and `idempotent` are a capability's [hints](../../../spec/catalog.md#capabilities) for clients. A hint you leave out is not in the catalog.
- `validate()` lists the rules that the catalog breaks. `render()` refuses to render a catalog that breaks any rule.

## Tests

Run `moon run catalog-typescript:test`. The tests compare the library's output, byte for byte, with these files:

| File | Contents |
| --- | --- |
| [`examples/library.acidcat.json`](examples/library.acidcat.json) | The lending-library catalog |
| [`../testdata/canonical.acidcat.json`](../testdata/canonical.acidcat.json) | The canonical form of [`../testdata/canonical.json`](../testdata/canonical.json): values that languages write differently by default |
| [`../testdata/hints.acidcat.json`](../testdata/hints.acidcat.json) | Each hint of a capability, in canonical order |

The air-conditioner example writes its catalog with this library in [`examples/aircon/catalog/typescript.ts`](../../../examples/aircon/catalog/typescript.ts), and its test compares the output with the Pkl catalog. The root `moon run check` checks that each committed catalog file is in canonical form.
