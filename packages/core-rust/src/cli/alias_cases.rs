use serde_json::{Map, Value, json};

use super::{AliasKind, cli_aliases};

const CASES: &str = include_str!("../../tests/fixtures/cli_alias_cases.json");

fn target_entries(entries: &Value) -> Map<String, Value> {
    entries
        .as_array()
        .expect("a list of entries")
        .iter()
        .filter(|entry| entry["inTarget"] == Value::Bool(true))
        .map(|entry| {
            let id = entry["id"].as_str().expect("an id").to_owned();
            let input = &entry["input"];
            let mut definition = json!({ "description": "" });
            if input.is_object() {
                definition["input"] = input.clone();
            }
            (id, definition)
        })
        .collect()
}

#[test]
fn the_aliases_give_the_errors_the_aliases_and_the_default_of_the_model_in_each_case() {
    let fixture: Value = serde_json::from_str(CASES).expect("the cases of the model are JSON");
    let target = fixture["target"].as_str().expect("a target");
    let capabilities = target_entries(&fixture["capabilities"]);
    let events = target_entries(&fixture["events"]);
    let cases = fixture["cases"].as_array().expect("a list of cases");
    assert!(!cases.is_empty());
    for case in cases {
        let surfaces: Vec<&str> = if case["surface"] == Value::Bool(true) {
            vec!["cli"]
        } else {
            Vec::new()
        };
        let options = case
            .get("settings")
            .map_or_else(|| json!({}), |settings| json!({ "cli": settings }));
        let catalog = json!({
            "targets": { target: { "surfaces": surfaces, "options": options } },
            "capabilities": capabilities,
            "events": events,
        });
        let result = cli_aliases(&catalog, target);
        let aliases: Vec<Value> = result
            .aliases
            .iter()
            .map(|alias| {
                let kind = match alias.kind {
                    AliasKind::Capability => "capability",
                    AliasKind::Event => "event",
                };
                let mut each = json!({ "name": alias.name, "kind": kind, "id": alias.id });
                if let Some(input) = &alias.fixed_input {
                    each["input"] = Value::Object(input.clone());
                }
                each
            })
            .collect();
        let actual = json!({
            "errors": result.errors,
            "aliases": aliases,
            "default": result.default.map(|alias| alias.name),
        });
        let expected = json!({
            "errors": case["errors"],
            "aliases": case["aliases"],
            "default": case["default"],
        });
        assert_eq!(actual, expected, "{case}");
    }
}
