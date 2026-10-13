# Catalog libraries

Libraries for writing a catalog in the language you already use. Each one builds a catalog, checks the catalog rules, and renders it in [canonical form](../../spec/catalog.md#canonical-form).

They are **authoring tools, not runtimes**. A program uses one to produce `acidcat.catalog.json` at build time. At runtime an application works from its own code (see [Build time and run time](../../spec/catalog.md#build-time-and-run-time)), and nothing reads the catalog through these libraries.

| Language | Directory | Published as | Test |
| --- | --- | --- | --- |
| TypeScript | [`typescript/`](typescript) | npm `@acidcat/catalog` | `moon run catalog-typescript:test` |
| Python | [`python/`](python) | PyPI `acidcat-catalog` | `moon run catalog-python:test` |
| Go | [`go/`](go) | `acidcat.dev/catalog` | `moon run catalog-go:test` |
| Rust | [`rust/`](rust) | crates.io `acidcat-catalog` | `moon run catalog-rust:test` |
| Pkl | [`pkl/`](pkl/Catalog.pkl) | Pkl package | `moon run check` |

## One shape in every language

| Step | Pkl | TypeScript | Python | Go | Rust |
| --- | --- | --- | --- | --- | --- |
| Start | `amends "Catalog.pkl"` | `new Catalog({ title })` | `Catalog(title=…)` | `catalog.New(title, description)` | `Catalog::new(title, description)` |
| Declare a target | `targets { ["cli"] { bindings { "cli" } } }` | `.target("cli", { bindings: ["cli"] })` | `.target("cli", bindings=["cli"])` | `.Target("cli", catalog.Target{…})` | `.target("cli", Target { … })` |
| Share a type | `types { ["Status"] { … } }`, then `module.ref("Status")` | `const status = c.type("Status", {…})` | `status = c.type("Status", {…})` | `status := c.Type("Status", …)` | `let status = c.r#type("Status", json!({…}))` |
| Declare a capability | `capabilities { ["aircon.power.set"] { … } }` | `.capability(id, { description, audience, … })` | `.capability(id, description=…, …)` | `.Capability(id, catalog.Capability{…})` | `.capability(id, Capability { … })` |
| Check the rules | while writing | `.validate()` | `.validate()` | `.Validate()` | `.validate()` |
| Render canonical JSON | `pkl eval`, then `acidcat format` | `.render()` | `.render()` | `.Render()` | `.render()` |

Schemas are plain JSON Schema objects in every language. Declaring a shared type returns the schema that references it, so a reference cannot name a type that does not exist.

The libraries check the [catalog rules](../../spec/conformance.md#catalog) that need no schema validator: well-formed ids, target, binding and type names; declared audiences; inputs that describe objects; references that resolve; no nested `$defs`. The [toolchain](../toolchain/README.md) (`acidcat check`) then validates the rendered document completely.

## Kept in step

Every library writes catalogs in canonical form, so the same catalog gives the same bytes in every language. Two fixtures hold them to it:

- [`examples/aircon.acidcat.json`](../../examples/aircon.acidcat.json): each library rebuilds the air-conditioner catalog from [`examples/aircon.pkl`](../../examples/aircon.pkl), and must render exactly this file.
- [`fixtures/edge.acidcat.json`](fixtures/edge.acidcat.json): numbers and strings that languages disagree on by default (`16.0`, `1e-7`, `1e21`, escapes, non-ASCII keys), which each library must render exactly.

Pkl writes JSON in its own order, so `moon run examples` passes its output through `acidcat format`.

A new language is welcome on the same terms: the same five steps, the same rules, a canonical writer, and both fixtures.
