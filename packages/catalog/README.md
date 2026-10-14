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

All libraries write catalogs in canonical form. Thus the same catalog gives the same bytes in all languages. Two files test this:

- [`examples/aircon.acidcat.json`](../../examples/aircon.acidcat.json): each library makes the air-conditioner catalog of [`examples/aircon.pkl`](../../examples/aircon.pkl), and MUST write exactly this file.
- [`fixtures/edge.acidcat.json`](fixtures/edge.acidcat.json): numbers and strings that languages write differently by default (`16.0`, `1e-7`, `1e21`, escapes, non-ASCII keys). Each library MUST write exactly this file.

Pkl writes JSON in its own order. Thus `moon run examples` sends the Pkl output through `acid-cat format`.

To add a language, use the same five steps and the same rules, write the canonical form, and pass the two tests.
