# @acidcat/catalog

The AcidCat catalog library for TypeScript, published to npm as `@acidcat/catalog`.

Write a catalog in TypeScript and render it in canonical form. No dependencies, and no runtime role: run it at build time to produce `acidcat.catalog.json`.

```ts
import { Catalog } from "@acidcat/sdk";

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
