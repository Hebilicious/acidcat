use acidcat::{Capability, Catalog, Target};
use serde_json::{Value, json};

#[path = "../examples/aircon.rs"]
mod aircon;

#[test]
fn writes_the_same_aircon_catalog_as_pkl() {
    let expected = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../examples/aircon.acidcat.json"
    ))
    .expect("examples/aircon.acidcat.json exists");
    let rendered = aircon::aircon_catalog()
        .render()
        .expect("the catalog conforms");
    let rendered: Value = serde_json::from_str(&rendered).unwrap();
    let expected: Value = serde_json::from_str(&expected).unwrap();
    assert_eq!(rendered, expected);
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
