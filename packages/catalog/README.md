# Catalog libraries

Write a catalog in the language that you use. Each library makes a catalog, checks the catalog rules, and writes the catalog in [canonical form](../../spec/catalog.md#canonical-form).

Use these libraries at build time, to write `acidcat.catalog.json`. At run time, an application does not use them (see [Build time and run time](../../spec/catalog.md#build-time-and-run-time)).

| Language | Directory | Registry name | Test |
| --- | --- | --- | --- |
| TypeScript | [`typescript/`](typescript) | npm `@acid-cat/catalog` | `moon run catalog-typescript:test` |
| Python | [`python/`](python) | PyPI `acid-cat-catalog` | `moon run catalog-python:test` |
| Go | [`go/`](go) | `github.com/Hebilicious/acidcat/packages/catalog/go` | `moon run catalog-go:test` |
| Rust | [`rust/`](rust) | crates.io `acid-cat-catalog` | `moon run catalog-rust:test` |
| Pkl | [`pkl/`](pkl) | Pkl package `package://pkg.pkl-lang.org/github.com/Hebilicious/acidcat/acid-cat-catalog` | `moon run catalog-pkl:test` |

## One shape in every language

| Step | Pkl | TypeScript | Python | Go | Rust |
| --- | --- | --- | --- | --- | --- |
| Start | `amends "Catalog.pkl"` | `new Catalog({ title })` | `Catalog(title=…)` | `catalog.New(title, description)` | `Catalog::new(title, description)` |
| Declare a target | `targets { ["cli"] { bindings { "cli" } } }` | `.target("cli", { bindings: ["cli"] })` | `.target("cli", bindings=["cli"])` | `.Target("cli", catalog.Target{…})` | `.target("cli", Target { … })` |
| Share a type | `types { ["Status"] { … } }`, then `module.ref("Status")` | `const status = c.type("Status", {…})` | `status = c.type("Status", {…})` | `status := c.Type("Status", …)` | `let status = c.r#type("Status", json!({…}))` |
| Declare a capability | `capabilities { ["aircon.power.set"] { … } }` | `.capability(id, { description, audience, … })` | `.capability(id, description=…, …)` | `.Capability(id, catalog.Capability{…})` | `.capability(id, Capability { … })` |
| Check the rules | while writing | `.validate()` | `.validate()` | `.Validate()` | `.validate()` |
| Render canonical JSON | `pkl eval`, then `acid-cat format` | `.render()` | `.render()` | `.Render()` | `.render()` |

In all languages, a schema is a plain JSON Schema object. When you declare a shared type, you get the schema that refers to it. Thus a reference always refers to a type that exists.

The libraries check the [catalog rules](../../spec/conformance.md#catalog) that need no schema validator: the form of ids and names, audiences, inputs, references, and nested `$defs`. Then `acid-cat check` from [`@acid-cat/cli`](../cli/README.md) does the full check.

## Identical output

All libraries write catalogs in canonical form. Thus the same catalog gives the same bytes in all languages.

Each library tests its own catalogs, with files in its own directory:

| Library | Example catalog | Edge-case catalog |
| --- | --- | --- |
| TypeScript | A lending library: [`typescript/examples/library.acidcat.json`](typescript/examples/library.acidcat.json) | [`typescript/test/fixtures/edge.acidcat.json`](typescript/test/fixtures/edge.acidcat.json) |
| Python | A weather station: [`python/examples/weather.acidcat.json`](python/examples/weather.acidcat.json) | [`python/tests/fixtures/edge.acidcat.json`](python/tests/fixtures/edge.acidcat.json) |
| Go | A garage door: [`go/examples/garage/garage.acidcat.json`](go/examples/garage/garage.acidcat.json) | [`go/testdata/edge.acidcat.json`](go/testdata/edge.acidcat.json) |
| Rust | A music player: [`rust/examples/player.acidcat.json`](rust/examples/player.acidcat.json) | [`rust/tests/fixtures/edge.acidcat.json`](rust/tests/fixtures/edge.acidcat.json) |
| Pkl | A greenhouse: [`pkl/examples/greenhouse.acidcat.json`](pkl/examples/greenhouse.acidcat.json) | None. `acid-cat format` writes the canonical form of the Pkl output. |

- The test of an example catalog makes the catalog with the library, and compares the output with the committed file, byte for byte.
- An edge-case catalog holds values that languages write differently by default: a number with a zero fraction, very small and very large numbers, escapes and control characters in strings, and non-ASCII keys. Each library uses different values.
- Each committed catalog file in the repository MUST be in canonical form. The root `moon run check` checks this. Thus all libraries agree on the canonical form, and they do not share a file.

[`examples/aircon/catalog`](../../examples/aircon/catalog) shows one catalog written in Pkl, TypeScript, Python, Go and Rust. Its test checks that each language gives the same bytes.

Pkl writes JSON in its own order. Thus `moon run examples` sends the Pkl output through `acid-cat format`.

To add a language, use the same five steps and the same rules, and write the canonical form. Add an example catalog in a new domain and an edge-case catalog with new values, both in the directory of the library, and test the output of the library against them.
