use acidcat::{Capability, Catalog, Target};
use serde_json::json;

#[path = "../examples/aircon.rs"]
mod aircon;

fn expected(path: &str) -> String {
    std::fs::read_to_string(format!("{}/../{path}", env!("CARGO_MANIFEST_DIR")))
        .expect("the expected file exists")
}

#[test]
fn writes_the_same_aircon_catalog_as_pkl() {
    let rendered = aircon::aircon_catalog()
        .render()
        .expect("the catalog conforms");
    assert_eq!(rendered, expected("../examples/aircon.acidcat.json"));
}

#[test]
fn writes_the_canonical_form_of_every_value() {
    let mut catalog = Catalog::new(None, None);
    catalog
        .target("cli", Target { bindings: vec!["cli".into()], ..Target::default() })
        .capability("edge.case.check", Capability {
            description: "Strings: \"quoted\", back\\slash, tab\t, é, \u{2028}, \u{1}, 😀.".into(),
            audience: vec!["cli".into()],
            output: Some(json!({
                "type": "object",
                "zKey": "last",
                "aKey": "first",
                "properties": { "é": { "type": "string" }, "z": { "type": "string" }, "Z": { "type": "string" } },
                "examples": [{
                    "whole": 16.0, "half": 0.5, "tiny": 1e-7, "small": 0.000001, "large": 1e21,
                    "big": 123456789012345680000.0, "negative": -2.5e-10, "zero": 0.0, "integer": 42
                }]
            })),
            ..Capability::default()
        });
    assert_eq!(
        catalog.render().expect("the catalog conforms"),
        expected("fixtures/edge.acidcat.json")
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
