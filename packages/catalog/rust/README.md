# acid-cat-catalog

The AcidCat catalog library for Rust. crates.io package: `acid-cat-catalog`.

Write a catalog in Rust, and write it in canonical form. Write schemas with `serde_json::json!`. Use it at build time, for example in `build.rs`, to write `acidcat.catalog.json`.

```sh
cargo add acid-cat-catalog
```

```rust
use acid_cat_catalog::{Capability, Catalog, Target};
use serde_json::json;

let mut catalog = Catalog::new(Some("Music player"), None);
catalog.target("remote", Target { bindings: vec!["cli".into()], ..Target::default() });
let unknown = catalog.r#type("UnknownTrack", json!({ "type": "object" }));
catalog.capability("player.track.play", Capability {
    description: "Play a track now.".into(),
    audience: vec!["remote".into()],
    input: Some(json!({ "type": "object", "required": ["id"], "properties": { "id": { "type": "string" } } })),
    failures: vec![("UnknownTrack".into(), unknown)],
    ..Capability::default()
});

std::fs::write("acidcat.catalog.json", catalog.render().expect("the catalog conforms"))?;
```

`validate()` lists the rules a catalog breaks, and `render()` returns them as an error. The full example is [`examples/player.rs`](examples/player.rs), a music player. Run it with `cargo run --example player`.

The tests compare the output of the library with files in this directory: the music-player catalog [`examples/player.acidcat.json`](examples/player.acidcat.json), and a catalog of values that languages write differently, [`tests/fixtures/edge.acidcat.json`](tests/fixtures/edge.acidcat.json). A test also compares [`examples/aircon.rs`](examples/aircon.rs) with the air-conditioner catalog of the repository. Each committed catalog file is in [canonical form](../../../spec/catalog.md#canonical-form), and the root `moon run check` checks this. Thus all catalog libraries agree on the canonical form, and they do not share a test file. Test with `moon run catalog-rust:test`.
