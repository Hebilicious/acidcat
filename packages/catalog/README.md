# Catalog libraries

Write a catalog in the language you already use. Each library builds a catalog, checks the catalog rules, and writes the catalog in [canonical form](../../spec/catalog.md#canonical-form), so the same catalog gives the same bytes in every language.

Use these libraries at build time to write `acidcat.catalog.json`. An application does not use them at run time (see [Build time and run time](../../spec/catalog.md#build-time-and-run-time)).

| Language | Directory | Registry name | Test |
| --- | --- | --- | --- |
| TypeScript | [`typescript/`](typescript) | npm `@acid-cat/catalog` | `moon run catalog-typescript:test` |
| Python | [`python/`](python) | PyPI `acid-cat-catalog` | `moon run catalog-python:test` |
| Go | [`go/`](go) | `github.com/Hebilicious/acidcat/packages/catalog/go` | `moon run catalog-go:test` |
| Rust | [`rust/`](rust) | crates.io `acid-cat-catalog` | `moon run catalog-rust:test` |
| Pkl | [`pkl/`](pkl) | Pkl package `package://pkg.pkl-lang.org/github.com/Hebilicious/acidcat/acid-cat-catalog` | `moon run catalog-pkl:test` |

## The same steps in every language

| Step | Pkl | TypeScript | Python | Go | Rust |
| --- | --- | --- | --- | --- | --- |
| Start | `amends "Catalog.pkl"` | `new Catalog({ title })` | `Catalog(title=…)` | `catalog.New(title, description)` | `Catalog::new(title, description)` |
| Declare a target | `targets { ["cli"] { bindings { "cli" } } }` | `.target("cli", { bindings: ["cli"] })` | `.target("cli", bindings=["cli"])` | `.Target("cli", catalog.Target{…})` | `.target("cli", Target { … })` |
| Share a type | `types { ["Status"] { … } }`, then `module.ref("Status")` | `const status = c.type("Status", {…})` | `status = c.type("Status", {…})` | `status := c.Type("Status", …)` | `let status = c.r#type("Status", json!({…}))` |
| Declare a capability | `capabilities { ["aircon.power.set"] { … } }` | `.capability(id, { description, audience, … })` | `.capability(id, description=…, …)` | `.Capability(id, catalog.Capability{…})` | `.capability(id, Capability { … })` |
| Declare an event | `events { ["aircon.status.changed"] { … } }` | `.event(id, { description, audience, input, payload })` | `.event(id, description=…, payload=…)` | `.Event(id, catalog.Event{…})` | `.event(id, Event { … })` |
| Check the rules | while writing | `.validate()` | `.validate()` | `.Validate()` | `.validate()` |
| Render canonical JSON | `pkl eval`, then `acid-cat format` | `.render()` | `.render()` | `.Render()` | `.render()` |

A schema is a plain JSON Schema object in every language. Declaring a shared type returns the schema that refers to it, so a reference always points at a type that exists.

The libraries check the [catalog rules](../../spec/conformance.md#catalog) that need no schema validator: the form of ids and names, audiences, inputs and payloads, ids that are both a capability and an event, references, and nested `$defs`. `acid-cat check` from [`@acid-cat/cli`](../cli/README.md) does the full check.

## How the libraries stay byte-identical

Each library tests its own catalogs, with files in its own directory. The libraries share no test file.

| Library | Example catalog | Edge-case catalog |
| --- | --- | --- |
| TypeScript | A lending library: [`typescript/examples/library.acidcat.json`](typescript/examples/library.acidcat.json) | [`typescript/test/fixtures/edge.acidcat.json`](typescript/test/fixtures/edge.acidcat.json) |
| Python | A weather station: [`python/examples/weather.acidcat.json`](python/examples/weather.acidcat.json) | [`python/tests/fixtures/edge.acidcat.json`](python/tests/fixtures/edge.acidcat.json) |
| Go | A garage door: [`go/examples/garage/garage.acidcat.json`](go/examples/garage/garage.acidcat.json) | [`go/testdata/edge.acidcat.json`](go/testdata/edge.acidcat.json) |
| Rust | A music player: [`rust/examples/player.acidcat.json`](rust/examples/player.acidcat.json) | [`rust/tests/fixtures/edge.acidcat.json`](rust/tests/fixtures/edge.acidcat.json) |
| Pkl | A greenhouse: [`pkl/examples/greenhouse.acidcat.json`](pkl/examples/greenhouse.acidcat.json) | None. `acid-cat format` writes the canonical form of the Pkl output. |

- An example catalog's test builds the catalog with the library and compares the output with the committed file, byte for byte.
- An edge-case catalog holds values that languages write differently by default: a number with a zero fraction, very small and very large numbers, escapes and control characters in strings, and non-ASCII keys. Each library uses different values.
- Each committed catalog file in the repository MUST be in canonical form, and the root `moon run check` checks this. That one check is what makes every library agree on the form.
- Pkl writes JSON in its own key order, so `moon run examples` sends the Pkl output through `acid-cat format`.

[`examples/aircon/catalog`](../../examples/aircon/catalog) writes one catalog in Pkl, TypeScript, Python, Go and Rust, and its test checks that each language gives the same bytes.

## Add a language

Follow the same steps and rules, and write the canonical form. In the new library's directory, add an example catalog in a new domain and an edge-case catalog with new values, and test the library's output against both.
