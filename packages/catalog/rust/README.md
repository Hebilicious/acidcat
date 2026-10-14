# acid-cat-catalog

The AcidCat catalog library for Rust. crates.io package: `acid-cat-catalog`.

Write a catalog in Rust, and write it in canonical form. Write schemas with `serde_json::json!`. Use it at build time, for example in `build.rs`, to write `acidcat.catalog.json`.

```sh
cargo add acid-cat-catalog
```

```rust
use acid_cat_catalog::{Capability, Catalog, Target};
use serde_json::json;

let mut catalog = Catalog::new(Some("Living-room air conditioner"), None);
catalog.target("cli", Target { bindings: vec!["cli".into()], ..Target::default() });
let offline = catalog.r#type("Offline", json!({ "type": "object" }));
catalog.capability("aircon.power.set", Capability {
    description: "Turn the unit on or off.".into(),
    audience: vec!["cli".into()],
    input: Some(json!({ "type": "object", "required": ["on"], "properties": { "on": { "type": "boolean" } } })),
    failures: vec![("Offline".into(), offline)],
    ..Capability::default()
});

std::fs::write("acidcat.catalog.json", catalog.render().expect("the catalog conforms"))?;
```

`validate()` lists the rules a catalog breaks, and `render()` returns them as an error. The full example is [`examples/aircon.rs`](examples/aircon.rs). Test with `moon run catalog-rust:test`.
