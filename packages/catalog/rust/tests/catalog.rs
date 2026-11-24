use acid_cat_catalog::{Capability, Catalog, Event, Target, canonical_json, canonical_text};
use serde_json::json;

#[path = "../examples/player.rs"]
mod player;

fn expected(path: &str) -> String {
    std::fs::read_to_string(format!("{}/{path}", env!("CARGO_MANIFEST_DIR")))
        .expect("the expected file exists")
}

fn testdata(name: &str) -> String {
    expected(&format!("../testdata/{name}"))
}

#[test]
fn writes_the_player_catalog_in_canonical_form() {
    let rendered = player::player_catalog()
        .render()
        .expect("the catalog conforms");
    assert_eq!(rendered, expected("examples/player.acidcat.json"));
}

#[test]
fn writes_every_value_of_the_shared_test_catalog() {
    let catalog: serde_json::Value =
        serde_json::from_str(&testdata("canonical.json")).expect("the shared test catalog is JSON");
    assert_eq!(canonical_text(&catalog), testdata("canonical.acidcat.json"));
}

#[test]
fn writes_the_hints_of_a_capability_in_canonical_order() {
    let mut catalog = Catalog::new(None, None);
    catalog
        .target(
            "agents",
            Target {
                surfaces: vec!["mcp".into()],
                ..Target::default()
            },
        )
        .capability(
            "notes.count.read",
            Capability {
                state: Some(json!({ "type": "integer" })),
                idempotent: Some(true),
                destructive: Some(false),
                read_only: true,
                audience: vec!["agents".into()],
                description: "Read the number of notes.".into(),
                ..Capability::default()
            },
        );
    assert_eq!(
        catalog.render().expect("the catalog conforms"),
        testdata("hints.acidcat.json")
    );
}

#[test]
fn reports_the_rules_a_catalog_breaks() {
    let mut catalog = Catalog::new(None, None);
    catalog
        .target(
            "cli",
            Target {
                surfaces: vec!["cli".into()],
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
            surfaces: vec!["cli".into()],
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
fn reports_a_boolean_schema() {
    let mut catalog = Catalog::new(None, None);
    catalog.target(
        "cli",
        Target {
            surfaces: vec!["cli".into()],
            ..Target::default()
        },
    );
    catalog.r#type("Anything", json!(true));
    catalog
        .capability(
            "a.b",
            Capability {
                description: "x".into(),
                input: Some(json!(true)),
                output: Some(json!(true)),
                failures: vec![("Gone".into(), json!(false))],
                state: Some(json!(true)),
                ..Capability::default()
            },
        )
        .event(
            "a.c",
            Event {
                description: "y".into(),
                input: Some(json!(false)),
                payload: Some(json!(true)),
                ..Event::default()
            },
        )
        .capability(
            "a.d",
            Capability {
                description: "z".into(),
                output: Some(
                    json!({ "type": "object", "additionalProperties": false, "items": true }),
                ),
                ..Capability::default()
            },
        );
    assert_eq!(
        catalog.validate(),
        [
            "the type Anything is not a JSON object",
            "a.b input is not a JSON object",
            "a.b output is not a JSON object",
            "a.b state is not a JSON object",
            "a.b failure Gone is not a JSON object",
            "a.c input is not a JSON object",
            "a.c payload is not a JSON object",
        ]
    );
    assert!(catalog.render().is_err());
}

#[test]
fn writes_canonical_json_with_no_spaces_and_every_key_sorted() {
    let value = json!({ "b": [1.0, "x\u{1}\"\n"], "a": { "d": null, "c": true } });
    assert_eq!(
        canonical_json(&value),
        r#"{"a":{"c":true,"d":null},"b":[1,"x\u0001\"\n"]}"#
    );
}
