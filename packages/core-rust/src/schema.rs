use schemars::JsonSchema;
use schemars::generate::SchemaSettings;
use serde_json::{Map, Value, json};

pub(crate) fn schema_of<T: JsonSchema>() -> (Value, Map<String, Value>) {
    let mut generator = SchemaSettings::draft2020_12()
        .with(|settings| settings.meta_schema = None)
        .into_generator();
    let mut schema = generator.root_schema_for::<T>().to_value();
    let types = match schema
        .as_object_mut()
        .and_then(|object| object.remove("$defs"))
    {
        Some(Value::Object(types)) => types,
        _ => Map::new(),
    };
    tidy(&mut schema);
    let types = types
        .into_iter()
        .map(|(name, mut schema)| {
            tidy(&mut schema);
            (name, schema)
        })
        .collect();
    (schema, types)
}

fn tidy(schema: &mut Value) {
    match schema {
        Value::Object(object) => {
            if matches!(
                object.get("type").and_then(Value::as_str),
                Some("integer" | "number")
            ) {
                object.remove("format");
            }
            let required: Vec<String> = object
                .get("required")
                .and_then(Value::as_array)
                .map(|names| {
                    names
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            if let Some(Value::Object(properties)) = object.get_mut("properties") {
                for (name, property) in properties.iter_mut() {
                    if !required.contains(name) {
                        without_null(property);
                    }
                }
            }
            for value in object.values_mut() {
                tidy(value);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(tidy),
        _ => {}
    }
}

fn without_null(property: &mut Value) {
    let Some(object) = property.as_object_mut() else {
        return;
    };
    if let Some(Value::Array(types)) = object.get("type") {
        let rest: Vec<Value> = types
            .iter()
            .filter(|each| *each != "null")
            .cloned()
            .collect();
        let replacement = if rest.len() == 1 {
            rest[0].clone()
        } else {
            Value::Array(rest)
        };
        object.insert("type".into(), replacement);
    }
    if let Some(Value::Array(members)) = object.get("anyOf") {
        let rest: Vec<Value> = members
            .iter()
            .filter(|each| **each != json!({ "type": "null" }))
            .cloned()
            .collect();
        if rest.len() == 1 && object.len() == 1 {
            *property = rest[0].clone();
        } else {
            object.insert("anyOf".into(), Value::Array(rest));
        }
    }
}

pub(crate) fn reference_name(schema: &Value) -> Option<&str> {
    schema.get("$ref")?.as_str()?.strip_prefix("#/$defs/")
}

pub(crate) fn resolve<'a>(schema: &'a Value, types: &'a Map<String, Value>) -> &'a Value {
    reference_name(schema)
        .and_then(|name| types.get(name))
        .unwrap_or(schema)
}

pub(crate) fn types_used_by(schema: &Value, types: &Map<String, Value>) -> Map<String, Value> {
    fn collect(node: &Value, types: &Map<String, Value>, used: &mut Map<String, Value>) {
        match node {
            Value::Object(object) => {
                if let Some(name) = reference_name(node)
                    && let Some(found) = types.get(name)
                    && !used.contains_key(name)
                {
                    used.insert(name.to_owned(), found.clone());
                    collect(found, types, used);
                }
                object
                    .values()
                    .for_each(|value| collect(value, types, used));
            }
            Value::Array(items) => items.iter().for_each(|item| collect(item, types, used)),
            _ => {}
        }
    }
    let mut used = Map::new();
    collect(schema, types, &mut used);
    used
}

pub(crate) fn bundle(schema: &Value, types: &Map<String, Value>) -> Value {
    let base = match schema.as_object() {
        Some(object) if object.len() == 1 => resolve(schema, types).clone(),
        _ => schema.clone(),
    };
    let used = types_used_by(&base, types);
    if used.is_empty() {
        return base;
    }
    let mut bundled = base;
    if let Some(object) = bundled.as_object_mut() {
        object.insert("$defs".into(), Value::Object(used));
    }
    bundled
}

/// The input schema that the CLI binding reads (spec/bindings/cli.md#commands): the bundled type that the `$ref` of the
/// schema refers to, whatever other keys the schema has. The flags, the usage and the choice of JSON text come from it.
pub(crate) fn cli_input_schema(schema: &Value, types: &Map<String, Value>) -> Value {
    bundle(resolve(schema, types), types)
}

pub(crate) fn view_of(catalog: &Value, target: &str) -> Value {
    let empty = Map::new();
    let types = catalog
        .get("$defs")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let mut used = Map::new();
    let mut filter = |member: &str, schemas: &dyn Fn(&Value) -> Vec<Value>| -> Map<String, Value> {
        let mut kept = Map::new();
        for (id, entry) in catalog
            .get(member)
            .and_then(Value::as_object)
            .unwrap_or(&empty)
        {
            let audience = entry.get("audience").and_then(Value::as_array);
            if !audience.is_some_and(|names| names.iter().any(|name| name == target)) {
                continue;
            }
            for schema in schemas(entry) {
                used.extend(types_used_by(&schema, types));
            }
            let mut entry = entry.clone();
            entry["audience"] = json!([target]);
            kept.insert(id.clone(), entry);
        }
        kept
    };
    let capabilities = filter("capabilities", &|capability| {
        let mut schemas: Vec<Value> = ["input", "output", "state"]
            .iter()
            .filter_map(|member| capability.get(*member).cloned())
            .collect();
        if let Some(failures) = capability.get("failures").and_then(Value::as_object) {
            schemas.extend(failures.values().cloned());
        }
        schemas
    });
    let events = filter("events", &|event| {
        ["input", "payload"]
            .iter()
            .filter_map(|member| event.get(*member).cloned())
            .collect()
    });

    let mut view = Map::new();
    for (member, value) in catalog.as_object().unwrap_or(&empty) {
        match member.as_str() {
            "targets" => {
                let mut targets = Map::new();
                if let Some(declared) = value.get(target) {
                    targets.insert(target.to_owned(), declared.clone());
                }
                view.insert("targets".into(), Value::Object(targets));
            }
            "$defs" | "events" => {}
            "capabilities" => {
                if !used.is_empty() {
                    view.insert("$defs".into(), Value::Object(used.clone()));
                }
                view.insert("capabilities".into(), Value::Object(capabilities.clone()));
                if !events.is_empty() {
                    view.insert("events".into(), Value::Object(events.clone()));
                }
            }
            _ => {
                view.insert(member.clone(), value.clone());
            }
        }
    }
    Value::Object(view)
}

pub(crate) struct Validator(jsonschema::Validator);

impl Validator {
    pub(crate) fn new(schema: &Value, types: &Map<String, Value>) -> Result<Self, String> {
        let mut bundled = schema.clone();
        let used = types_used_by(schema, types);
        if !used.is_empty()
            && let Some(object) = bundled.as_object_mut()
        {
            object.insert("$defs".into(), Value::Object(used));
        }
        jsonschema::draft202012::new(&bundled)
            .map(Validator)
            .map_err(|error| error.to_string())
    }

    pub(crate) fn issues(&self, value: &Value) -> Option<String> {
        let issues: Vec<String> = self
            .0
            .iter_errors(value)
            .map(|error| {
                let path = error.instance_path().to_string();
                format!(
                    "{}: {}",
                    if path.is_empty() {
                        "input".to_owned()
                    } else {
                        path
                    },
                    error
                )
            })
            .collect();
        if issues.is_empty() {
            None
        } else {
            Some(issues.join("; "))
        }
    }
}
