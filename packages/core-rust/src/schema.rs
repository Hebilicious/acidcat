//! Schemas: the schemas of Rust types, references, bundling, views and canonical JSON (spec/catalog.md).

use std::collections::BTreeMap;

use schemars::JsonSchema;
use schemars::generate::SchemaSettings;
use serde_json::{Map, Value, json};

/// The JSON Schema 2020-12 schema of a Rust type, and the types that it refers to.
///
/// The schema follows these rules, so that it fits a catalog:
///
/// - it has no `$schema` member;
/// - an `Option` field that is not required takes the value of its type, and not `null`;
/// - an integer or a number has no `format` such as `int64`.
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

/// Apply the rules of [`schema_of`] at all levels of a schema.
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

/// Remove `null` from the values of an optional property: `"type": ["string", "null"]` becomes `"type": "string"`,
/// and `{ "type": "null" }` leaves an `anyOf`.
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

/// The name of the type that a `$ref` of the form `#/$defs/<Name>` refers to.
pub(crate) fn reference_name(schema: &Value) -> Option<&str> {
    schema.get("$ref")?.as_str()?.strip_prefix("#/$defs/")
}

/// The type that a schema's `$ref` refers to, or the schema itself.
pub(crate) fn resolve<'a>(schema: &'a Value, types: &'a Map<String, Value>) -> &'a Value {
    reference_name(schema)
        .and_then(|name| types.get(name))
        .unwrap_or(schema)
}

/// The types that a schema uses, directly or through other types, in the order in which it finds them.
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

/// Bundle a schema (spec/catalog.md#bundling): copy the types that it uses into its `$defs`. A schema that is only a
/// `$ref` becomes the type that it refers to.
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

/// The view of a target (spec/catalog.md#views).
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

/// The canonical JSON of a value (spec/bindings/mcp.md#canonical-json): no spaces, the keys of each object in code
/// point order, and strings and numbers as the canonical form of a catalog writes them (spec/catalog.md#canonical-form),
/// which is how ECMAScript writes them. Rust strings compare by bytes of UTF-8, which is the order of code points.
pub(crate) fn canonical_json(value: &Value) -> String {
    let mut out = String::new();
    write_canonical(&mut out, value);
    out
}

fn write_canonical(out: &mut String, value: &Value) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => out.push_str(&number_text(number)),
        Value::String(text) => write_string(out, text),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_canonical(out, item);
            }
            out.push(']');
        }
        Value::Object(object) => {
            let sorted: BTreeMap<&String, &Value> = object.iter().collect();
            out.push('{');
            for (index, (key, item)) in sorted.into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_string(out, key);
                out.push(':');
                write_canonical(out, item);
            }
            out.push('}');
        }
    }
}

/// Escape a string exactly as ECMAScript's `JSON.stringify` does.
fn write_string(out: &mut String, text: &str) {
    out.push('"');
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            control if (control as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", control as u32));
            }
            other => out.push(other),
        }
    }
    out.push('"');
}

/// The largest integer that an ECMAScript number holds exactly: 2^53.
const EXACT_INTEGER_LIMIT: u64 = 1 << 53;

/// Write a number the way ECMAScript's `Number::toString` does. A client in ECMAScript reads each JSON number as a
/// 64-bit float, so an integer larger than 2^53 is written from its float value, as that client writes it.
fn number_text(number: &serde_json::Number) -> String {
    if let Some(integer) = number.as_i64()
        && integer.unsigned_abs() <= EXACT_INTEGER_LIMIT
    {
        return integer.to_string();
    }
    let value = number.as_f64().unwrap_or(0.0);
    // ECMAScript writes both 0 and -0 as "0".
    if value == 0.0 {
        return "0".to_owned();
    }
    // `{:e}` gives the shortest digits that read back as the same float, in the form d.ddde±x.
    let scientific = format!("{:e}", value.abs());
    let (mantissa, exponent) = scientific.split_once('e').unwrap_or((&scientific, "0"));
    let exponent: i32 = exponent.parse().unwrap_or(0);
    let digits = mantissa.replace('.', "");
    let digits = digits.trim_end_matches('0');
    let sign = if value < 0.0 { "-" } else { "" };
    format!("{sign}{}", layout(digits, exponent + 1))
}

/// Lay out the number `0.<digits> × 10^n` as ECMAScript's `Number::toString` does.
fn layout(digits: &str, n: i32) -> String {
    let k = digits.len() as i32;
    if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let mantissa = if k > 1 {
            format!("{}.{}", &digits[..1], &digits[1..])
        } else {
            digits.to_owned()
        };
        format!("{mantissa}e{}{}", if e > 0 { "+" } else { "-" }, e.abs())
    }
}

/// A JSON Schema validator for one schema of the catalog. The schema is bundled, so that each `$ref` resolves.
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

    /// The issues of a value, each with its path, or `None` when the value agrees with the schema.
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

#[cfg(test)]
mod tests {
    use super::canonical_json;
    use serde_json::json;

    #[test]
    fn canonical_json_writes_numbers_as_ecmascript_does() {
        let cases = [
            (json!(22.0), "22"),
            (json!(1e21), "1e+21"),
            (json!(1.5e-7), "1.5e-7"),
            (json!(-0.0), "0"),
            (json!(123456789012345680000.0), "123456789012345680000"),
            (json!(0.000001), "0.000001"),
            (json!(-2.5), "-2.5"),
            (json!(42), "42"),
            (json!(-7), "-7"),
            (json!(u64::MAX), "18446744073709552000"),
        ];
        for (value, text) in cases {
            assert_eq!(canonical_json(&value), text, "the number {value}");
        }
    }

    #[test]
    fn canonical_json_sorts_keys_and_escapes_strings() {
        let value = json!({ "b": [1.0, "x\u{1}\"\n"], "a": { "d": null, "c": true } });
        assert_eq!(
            canonical_json(&value),
            r#"{"a":{"c":true,"d":null},"b":[1,"x\u0001\"\n"]}"#
        );
    }
}
