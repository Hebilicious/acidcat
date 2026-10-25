use acid_cat_catalog::{Capability, Catalog, Target};
use serde_json::json;

#[path = "../examples/aircon.rs"]
mod aircon;

#[path = "../examples/player.rs"]
mod player;

/// Reads a file. The path is relative to this package.
fn expected(path: &str) -> String {
    std::fs::read_to_string(format!("{}/{path}", env!("CARGO_MANIFEST_DIR")))
        .expect("the expected file exists")
}

#[test]
fn writes_the_same_aircon_catalog_as_pkl() {
    let rendered = aircon::aircon_catalog()
        .render()
        .expect("the catalog conforms");
    assert_eq!(rendered, expected("../../../examples/aircon.acidcat.json"));
}

#[test]
fn writes_the_player_catalog_in_canonical_form() {
    let rendered = player::player_catalog()
        .render()
        .expect("the catalog conforms");
    assert_eq!(rendered, expected("examples/player.acidcat.json"));
}

/// A catalog with numbers and strings that Rust writes differently from the canonical form by default.
fn edge_catalog() -> Catalog {
    let mut catalog = Catalog::new(None, None);
    catalog
        .target("speaker", Target { bindings: vec!["cli".into()], ..Target::default() })
        .capability("edge.values.print", Capability {
            description: "Text: \"loud\", E:\\music, newline\n, back\u{8}, gs\u{1d}, del\u{7f}, ps\u{2029}, ø, 🎵.".into(),
            audience: vec!["speaker".into()],
            output: Some(json!({
                "type": "object",
                "xKey": "x",
                "dKey": "d",
                "properties": { "ø": { "type": "string" }, "Ø": { "type": "string" }, "o": { "type": "string" }, "0": { "type": "string" } },
                "examples": [{
                    "whole": 128.0, "tenth": 0.1, "tiny": 8.5e-12, "small": 0.0000099, "large": 4.4e23,
                    "big": 161803398874989500000.0, "negative": -3.5e-9, "zero": 0.0, "integer": 440
                }]
            })),
            ..Capability::default()
        });
    catalog
}

#[test]
fn writes_the_canonical_form_of_every_value() {
    assert_eq!(
        edge_catalog().render().expect("the catalog conforms"),
        expected("tests/fixtures/edge.acidcat.json")
    );
}

#[test]
fn reports_the_rules_a_catalog_breaks() {
    let mut catalog = Catalog::new(None, None);
    catalog
        .target(
            "cli",
            Target {
                bindings: vec!["cli".into()],
                ..Target::default()
            },
        )
        .capability(
            "Bad.Id",
            Capability {
                description: "x".into(),
                ..Capability::default()
            },
        )
        .capability(
            "a.b",
            Capability {
                description: "y".into(),
                audience: vec!["clii".into()],
                ..Capability::default()
            },
        )
        .capability(
            "a.c",
            Capability {
                description: "z".into(),
                input: Some(json!({ "type": "string" })),
                ..Capability::default()
            },
        )
        .capability(
            "a.d",
            Capability {
                description: "w".into(),
                output: Some(json!({ "$ref": "#/$defs/Nope" })),
                ..Capability::default()
            },
        );
    assert_eq!(
        catalog.validate(),
        [
            "the id Bad.Id is malformed",
            "a.b names the undeclared target clii",
            "a.c input does not describe an object",
            "a.d references #/$defs/Nope, which is not a type",
        ]
    );
    assert!(catalog.render().is_err());
}
