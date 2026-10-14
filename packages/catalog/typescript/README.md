# @acid-cat/catalog

The AcidCat catalog library for TypeScript. npm package: `@acid-cat/catalog`.

Write a catalog in TypeScript, and write it in canonical form. The library has no dependencies. Use it at build time to write `acidcat.catalog.json`.

```sh
pnpm add -D @acid-cat/catalog
```

```ts
import { Catalog } from "@acid-cat/catalog";

const catalog = new Catalog({ title: "Living-room air conditioner" });
catalog.target("cli", { bindings: ["cli"] });
const offline = catalog.type("Offline", { type: "object" });
catalog.capability("aircon.power.set", {
  description: "Turn the unit on or off.",
  audience: ["cli"],
  input: { type: "object", required: ["on"], properties: { on: { type: "boolean" } } },
  failures: { Offline: offline },
});

await writeFile("acidcat.catalog.json", catalog.render());
```

`validate()` lists the rules a catalog breaks, and `render()` refuses to render one that breaks any. The full example is [`examples/aircon.ts`](examples/aircon.ts). Test with `moon run catalog-typescript:test`.
