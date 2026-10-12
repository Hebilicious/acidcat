# AcidCat SDK for Rust

Write a catalog in Rust and render it to JSON, with schemas written in `serde_json::json!`. No runtime role: run it at build time, for example from a `build.rs` or a small binary, to produce `acidcat.catalog.json`.

```rust
use acidcat::{Capability, Catalog, Target};
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

`validate()` lists the rules a catalog breaks, and `render()` returns them as an error. The full example is [`examples/aircon.rs`](examples/aircon.rs). Test with `cargo test --manifest-path sdk/rust/Cargo.toml`.
