---
title: Write a catalog
description: Write the catalog from a source in any supported language, and let the tool write the canonical JSON.
sidebar:
  order: 21
---

The catalog is a JSON document, but you seldom write the JSON yourself. Write a **source**, and let a tool write the JSON. A source finds errors before it writes the file, shares types, and gives the same bytes each time.

## Choose a source

| Situation | Source | What writes the JSON |
| --- | --- | --- |
| One application with one core | The code of the application | The core: `renderCatalog(app, { toJsonSchema })` in core-ts, `App.render(app)` in core-effect, `app.render_catalog()` in core-rust |
| A catalog that several implementations share | A Pkl module, or a program with a catalog library | `pkl eval`, then `acid-cat format --write`; or the program |

When no code writes the catalog, use Pkl. Pkl checks the catalog rules while you write.

## The same steps in every language

Each catalog library gives the same steps. Every library writes the catalog in [canonical form](/spec/catalog/#canonical-form), so the same catalog gives the same bytes in every language.

<CatalogSteps />

A schema is a plain JSON Schema object in every language. Declaring a shared type returns the schema that refers to it, so a reference always points at a type that exists.

## A first catalog

Install the catalog library of your language:

<EcosystemInstall of="catalog-languages" />

Each example declares one target, one shared type, one capability and one event, then writes the catalog.

<EcosystemTabs of="catalog-languages">
<TabItem for="typescript">

```ts title="library.ts"
import { writeFile } from "node:fs/promises";

import { Catalog } from "@acid-cat/catalog";

const catalog = new Catalog({ title: "Neighbourhood lending library" });
catalog.target("desk", { surfaces: ["cli"] });
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

`render()` refuses to render a catalog that breaks a rule. `validate()` lists the rules that the catalog breaks.

</TabItem>
<TabItem for="python">

```python title="weather.py"
from pathlib import Path
from acid_cat_catalog import Catalog

catalog = Catalog(title="Hilltop weather station")
catalog.target("logger", surfaces=["http"])
fault = catalog.type("SensorFault", {"type": "object"})
catalog.capability(
    "weather.sensor.calibrate",
    description="Correct one sensor by a fixed offset.",
    audience=["logger"],
    input={"type": "object", "required": ["offset"], "properties": {"offset": {"type": "number"}}},
    failures={"SensorFault": fault},
)
catalog.event(
    "weather.alert.raised",
    description="A reading passed a limit. The occurrence gives the reading.",
    audience=["logger"],
    input={"type": "object", "properties": {}},
    payload={"type": "object", "properties": {"celsius": {"type": "number"}}},
)

Path("acidcat.catalog.json").write_text(catalog.render())
```

`render()` raises `CatalogError` for a catalog that breaks a rule. The hints are `read_only`, `destructive` and `idempotent`.

</TabItem>
<TabItem for="go">

The Go package is named `catalog`. Import it with `import "github.com/Hebilicious/acidcat/packages/catalog/go"`. This excerpt is the body of a function:

```go title="garage.go"
c := catalog.New("Garage door", "")
c.Target("phone", catalog.Target{Surfaces: []string{"typescript"}})
obstructed := c.Type("Obstructed", catalog.Schema{"type": "object"})
c.Capability("garage.door.open", catalog.Capability{
	Description: "Open the door.",
	Audience:    []string{"phone"},
	Input:       catalog.Schema{"type": "object", "properties": catalog.Schema{"light": catalog.Schema{"type": "boolean"}}},
	Failures:    map[string]catalog.Schema{"Obstructed": obstructed},
})
c.Event("garage.door.moved", catalog.Event{
	Description: "The door started or stopped. The occurrence gives the position of the door.",
	Audience:    []string{"phone"},
	Input:       catalog.Schema{"type": "object", "properties": catalog.Schema{}},
	Payload:     catalog.Schema{"type": "object", "properties": catalog.Schema{"position": catalog.Schema{"type": "string"}}},
})

text, err := c.Render()
```

`Destructive` and `Idempotent` are `*bool`: write `new(true)` or `new(false)`, or leave them nil. The full example is [`examples/garage/garage.go`](https://github.com/Hebilicious/acidcat/blob/main/packages/catalog/go/examples/garage/garage.go).

</TabItem>
<TabItem for="rust">

Write schemas with `serde_json::json!`. Use the library at build time, for example in `build.rs`. This excerpt is the body of a function that returns a `Result`:

```rust title="player.rs"
use acid_cat_catalog::{Capability, Catalog, Event, Target};
use serde_json::json;

let mut catalog = Catalog::new(Some("Music player"), None);
catalog.target("remote", Target { surfaces: vec!["cli".into()], ..Target::default() });
let unknown = catalog.r#type("UnknownTrack", json!({ "type": "object" }));
catalog.capability("player.track.play", Capability {
    description: "Play a track now.".into(),
    audience: vec!["remote".into()],
    input: Some(json!({ "type": "object", "required": ["id"], "properties": { "id": { "type": "string" } } })),
    failures: vec![("UnknownTrack".into(), unknown)],
    ..Capability::default()
});
catalog.event("player.track.started", Event {
    description: "The speaker started to play a track. The occurrence gives the track.".into(),
    audience: vec!["remote".into()],
    input: Some(json!({ "type": "object", "properties": {} })),
    payload: Some(json!({ "type": "object", "properties": { "id": { "type": "string" } } })),
});

std::fs::write("acidcat.catalog.json", catalog.render().expect("the catalog conforms"))?;
```

`destructive` and `idempotent` are `Option<bool>`. The full example is [`examples/player.rs`](https://github.com/Hebilicious/acidcat/blob/main/packages/catalog/rust/examples/player.rs).

</TabItem>
<TabItem for="pkl">

The first line amends the published package. Replace `<version>` with the version of a release of `acid-cat-catalog`, as the install step shows.

```pkl title="greenhouse.pkl"
amends "package://pkg.pkl-lang.org/github.com/Hebilicious/acidcat/acid-cat-catalog@<version>#/Catalog.pkl"

targets {
  ["panel"] { surfaces { "typescript" } }
}

capabilities {
  ["greenhouse.vents.set"] {
    description = "Open the roof vents to a percentage."
    audience { "panel" }
  }
}

events {
  ["greenhouse.tank.low"] {
    description = "The rain-water tank fell below a level. The occurrence gives the litres that are left."
    audience { "panel" }
    payload {
      type = "object"
      properties { litres { type = "number" } }
    }
  }
}
```

Pkl writes JSON in its own key order. Render the module, then put it in canonical form:

```sh
pkl eval greenhouse.pkl --output-path greenhouse.acidcat.json
acid-cat format --write greenhouse.acidcat.json
```

</TabItem>
</EcosystemTabs>

## One catalog in every language

The air conditioner writes one catalog in each supported language, and its test checks that each language gives the same bytes. Here is the capability `aircon.power.set` in each source, with the helper `setting` that it calls, and the JSON that each source writes. Each source first declares the shared type `Offline` and the list of targets `everywhere`.

<CatalogExample capability="aircon.power.set" />

The sources are in [`examples/aircon/catalog`](/examples/catalog/).

## Check the result

Run `acid-cat check` on the JSON after each change:

```sh
acid-cat check --strict aircon.acidcat.json
```

The catalog libraries check the rules that need no schema validator. `acid-cat check` does the full check, and `--strict` also fails on warnings, such as a file that is not in canonical form.

::: tip
Commit the source and the JSON together. Never change the JSON of a catalog that has a source: change the source, and write the JSON again. Add a step to your build that writes the JSON again and fails when it differs.
:::

## JSON by hand

A JSON document is a catalog when it conforms, however it was written. If you write the JSON by hand, run `acid-cat check --strict` and `acid-cat format --write` after each change.

## Read more

- [Catalog](/docs/concepts/catalog/) and [Capabilities](/docs/concepts/capabilities/)
- [Catalog](/spec/catalog/) in the specification
- [Packages](/packages/), with the registry name of each catalog library
- [The catalog in each language](/examples/catalog/), in a code explorer
