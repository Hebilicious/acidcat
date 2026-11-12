use acid_cat_catalog::{Capability, Catalog, Event, Target, canonical_text};
use serde_json::json;

#[path = "../examples/player.rs"]
mod player;

/// Reads a file. The path is relative to this package.
fn expected(path: &str) -> String {
    std::fs::read_to_string(format!("{}/{path}", env!("CARGO_MANIFEST_DIR")))
        .expect("the expected file exists")
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
                "properties": { "ø": { "type": "string" }, "Ø": { "type": "string" }, "o": { "type": "string" }, "0": { "type": "string" }, "9": { "type": "string" }, "10": { "type": "string" } },
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

#[test]
fn reports_the_rules_an_event_breaks() {
    let mut catalog = Catalog::new(None, None);
    catalog.target(
        "cli",
        Target {
            bindings: vec!["cli".into()],
            ..Target::default()
        },
    );
    let name = catalog.r#type("Name", json!({ "type": "string" }));
    catalog
        .capability(
            "a.b",
            Capability {
                description: "x".into(),
                ..Capability::default()
            },
        )
        .event(
            "a.b",
            Event {
                description: "y".into(),
                ..Event::default()
            },
        )
        .event(
            "a.c",
            Event {
                description: "z".into(),
                audience: vec!["clii".into()],
                input: Some(json!({ "type": "string" })),
                ..Event::default()
            },
        )
        .event(
            "a.d",
            Event {
                description: "w".into(),
                payload: Some(name),
                ..Event::default()
            },
        )
        .event(
            "a.e",
            Event {
                description: "v".into(),
                payload: Some(json!({ "type": "object", "$defs": {} })),
                ..Event::default()
            },
        );
    assert_eq!(
        catalog.validate(),
        [
            "a.b is both a capability and an event",
            "a.c names the undeclared target clii",
            "a.c input does not describe an object",
            "a.d payload does not describe an object",
            "a.e carries its own $defs; declare shared types with r#type()",
        ]
    );
}

#[test]
fn puts_events_after_capabilities_and_the_members_of_an_event_in_order() {
    let text = canonical_text(&json!({
        "events": {
            "z.b.changed": { "payload": { "type": "object" }, "input": { "type": "object" }, "description": "b" },
            "z.a.changed": { "description": "a" }
        },
        "capabilities": {},
        "targets": {},
        "acidcat": "0.1"
    }));
    let expected = r#"{
  "acidcat": "0.1",
  "targets": {},
  "capabilities": {},
  "events": {
    "z.a.changed": {
      "description": "a"
    },
    "z.b.changed": {
      "description": "b",
      "input": {
        "type": "object"
      },
      "payload": {
        "type": "object"
      }
    }
  }
}
"#;
    assert_eq!(text, expected);
}

#[test]
fn a_catalog_with_no_events_has_no_events_member() {
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
            "a.b",
            Capability {
                description: "x".into(),
                audience: vec!["cli".into()],
                ..Capability::default()
            },
        );
    let document = catalog.to_json().expect("the catalog conforms");
    assert!(document.get("events").is_none());
}
