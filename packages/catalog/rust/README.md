# acid-cat-catalog

The AcidCat catalog library for Rust, published on crates.io as `acid-cat-catalog`. Build a catalog in code and write it in [canonical form](../../../spec/catalog.md#canonical-form). Write schemas with `serde_json::json!`. Use it at build time, for example in `build.rs`, to write `acidcat.catalog.json`.

## Install

```sh
cargo add acid-cat-catalog
```

## Example

```rust
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

The full example, a music player, is [`examples/player.rs`](examples/player.rs). Run it with `cargo run --example player`.

## API

- `event()` declares an [event](../../../spec/events.md). Clients subscribe to it and get its payload in each occurrence. A payload is an object, or a reference to a type that is an object.
- `read_only`, `destructive` and `idempotent` are a capability's [hints](../../../spec/catalog.md#capabilities) for clients. `destructive` and `idempotent` are `Option<bool>`. A hint you leave out is not in the catalog.
- `validate()` lists the rules that the catalog breaks. `render()` returns them as an error.
- `canonical_text()` writes a catalog that you have as a `serde_json::Value` in canonical form. `canonical_json()` writes any value as [canonical JSON](../../../spec/surfaces/mcp.md#canonical-json): no spaces, and every key sorted. [`acid-cat-core`](../../core-rust/README.md) uses it for its lease and subscription keys.

## Tests

Run `moon run catalog-rust:test`. The tests compare the library's output, byte for byte, with these files:

| File | Contents |
| --- | --- |
| [`examples/player.acidcat.json`](examples/player.acidcat.json) | The music-player catalog |
| [`../testdata/canonical.acidcat.json`](../testdata/canonical.acidcat.json) | The canonical form of [`../testdata/canonical.json`](../testdata/canonical.json): values that languages write differently by default |
| [`../testdata/hints.acidcat.json`](../testdata/hints.acidcat.json) | Each hint of a capability, in canonical order |

The air-conditioner example writes its catalog with this library in [`examples/aircon/catalog/rust`](../../../examples/aircon/catalog/rust), and its test compares the output with the Pkl catalog. The root `moon run check` checks that each committed catalog file is in canonical form.
