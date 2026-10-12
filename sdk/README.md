# SDKs

Libraries for writing a catalog in the language you already use. Each one builds a catalog, checks the catalog rules, and renders the JSON document that the toolchain validates and commits.

They are **authoring tools, not runtimes**. A program uses one to produce `acidcat.catalog.json` at build time. At runtime an application works from its own code (see [Build time and run time](../spec/catalog.md#build-time-and-run-time)), and nothing reads the catalog through an SDK.

| Language | Path | Test |
| --- | --- | --- |
| Pkl | [`pkl/`](pkl/Catalog.pkl) | `moon run check` (rendered through `acidcat format`) |
| TypeScript | [`typescript/`](typescript) | `moon run sdk-typescript` |
| Python | [`python/`](python) | `moon run sdk-python` |
| Go | [`go/`](go) | `moon run sdk-go` |
| Rust | [`rust/`](rust) | `moon run sdk-rust` |

## One shape in every language

| Step | Pkl | TypeScript | Python | Go | Rust |
| --- | --- | --- | --- | --- | --- |
| Start | `amends "Catalog.pkl"` | `new Catalog({ title })` | `Catalog(title=…)` | `acidcat.New(title, description)` | `Catalog::new(title, description)` |
| Declare a target | `targets { ["cli"] { bindings { "cli" } } }` | `.target("cli", { bindings: ["cli"] })` | `.target("cli", bindings=["cli"])` | `.Target("cli", acidcat.Target{…})` | `.target("cli", Target { … })` |
| Share a type | `types { ["Status"] { … } }`, then `module.ref("Status")` | `const status = catalog.type("Status", {…})` | `status = catalog.type("Status", {…})` | `status := catalog.Type("Status", …)` | `let status = catalog.r#type("Status", json!({…}))` |
| Declare a capability | `capabilities { ["aircon.power.set"] { … } }` | `.capability(id, { description, audience, … })` | `.capability(id, description=…, …)` | `.Capability(id, acidcat.Capability{…})` | `.capability(id, Capability { … })` |
| Check the rules | while writing | `.validate()` | `.validate()` | `.Validate()` | `.validate()` |
| Render canonical JSON | `pkl eval`, then `acidcat format` | `.render()` | `.render()` | `.Render()` | `.render()` |

Schemas are plain JSON Schema objects in every language. Declaring a shared type returns the schema that references it, so a reference cannot name a type that does not exist.

The SDKs check the [catalog rules](../spec/conformance.md#catalog) that need no schema validator: well-formed ids, target, binding and type names; declared audiences; inputs that describe objects; references that resolve; no nested `$defs`. The [toolchain](../toolchain/README.md) (`acidcat check`) then validates the rendered document completely.

## Kept in step

Every SDK writes catalogs in [canonical form](../spec/catalog.md#canonical-form), so the same catalog gives the same bytes in every language. Two fixtures hold them to it:

- [`examples/aircon.acidcat.json`](../examples/aircon.acidcat.json): each SDK rebuilds the air-conditioner catalog from [`examples/aircon.pkl`](../examples/aircon.pkl) in its own language, and must render exactly this file.
- [`fixtures/edge.acidcat.json`](fixtures/edge.acidcat.json): numbers and strings that languages disagree on by default (`16.0`, `1e-7`, `1e21`, escapes, non-ASCII keys), which each SDK must render exactly.

Pkl renders JSON in its own order, so `moon run examples` passes its output through `acidcat format`.

A new language is welcome on the same terms: the same five steps, the same rules, a canonical writer, and both fixtures.
