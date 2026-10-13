//! The canonical form of a catalog (spec/catalog.md#canonical-form): the one way to write a catalog as text, so that
//! every tool and every catalog library produces the same bytes for the same catalog.

use serde_json::{Map, Number, Value};

const CATALOG_ORDER: [&str; 6] = [
    "acidcat",
    "title",
    "description",
    "targets",
    "$defs",
    "capabilities",
];
const TARGET_ORDER: [&str; 3] = ["bindings", "description", "options"];
const CAPABILITY_ORDER: [&str; 7] = [
    "description",
    "audience",
    "input",
    "output",
    "failures",
    "readOnly",
    "state",
];

/// A catalog in canonical form, as text.
pub fn canonical_text(catalog: &Value) -> String {
    let mut out = String::new();
    write(&mut out, &canonical_catalog(catalog), "");
    out.push('\n');
    out
}

fn canonical_catalog(catalog: &Value) -> Value {
    ordered(catalog, &CATALOG_ORDER, |key, value| match key {
        "targets" => by_key(value, |target| {
            ordered(target, &TARGET_ORDER, |_, inner| sorted(inner))
        }),
        "$defs" => by_key(value, sorted),
        "capabilities" => by_key(value, |capability| {
            ordered(capability, &CAPABILITY_ORDER, |member, inner| {
                if member == "failures" {
                    by_key(inner, sorted)
                } else {
                    sorted(inner)
                }
            })
        }),
        _ => sorted(value),
    })
}

/// The known members in their order, then every other member sorted by key.
fn ordered(value: &Value, order: &[&str], each: impl Fn(&str, &Value) -> Value) -> Value {
    let Some(object) = value.as_object() else {
        return value.clone();
    };
    let mut out = Map::new();
    for key in order.iter().filter(|key| object.contains_key(**key)) {
        out.insert((*key).to_owned(), each(key, &object[*key]));
    }
    let mut others: Vec<&String> = object
        .keys()
        .filter(|key| !order.contains(&key.as_str()))
        .collect();
    others.sort();
    for key in others {
        out.insert(key.clone(), each(key, &object[key]));
    }
    Value::Object(out)
}

fn by_key(value: &Value, each: impl Fn(&Value) -> Value) -> Value {
    let Some(object) = value.as_object() else {
        return value.clone();
    };
    let mut keys: Vec<&String> = object.keys().collect();
    keys.sort();
    Value::Object(
        keys.into_iter()
            .map(|key| (key.clone(), each(&object[key])))
            .collect(),
    )
}

/// Every object's keys sorted, at every depth. Arrays keep their order.
fn sorted(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
        Value::Object(_) => by_key(value, sorted),
        _ => value.clone(),
    }
}

fn write(out: &mut String, value: &Value, indent: &str) {
    let inner = format!("{indent}  ");
    match value {
        Value::Object(object) if object.is_empty() => out.push_str("{}"),
        Value::Object(object) => {
            out.push_str("{\n");
            for (i, (key, item)) in object.iter().enumerate() {
                if i > 0 {
                    out.push_str(",\n");
                }
                out.push_str(&inner);
                write_string(out, key);
                out.push_str(": ");
                write(out, item, &inner);
            }
            out.push('\n');
            out.push_str(indent);
            out.push('}');
        }
        Value::Array(items) if items.is_empty() => out.push_str("[]"),
        Value::Array(items) => {
            out.push_str("[\n");
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push_str(",\n");
                }
                out.push_str(&inner);
                write(out, item, &inner);
            }
            out.push('\n');
            out.push_str(indent);
            out.push(']');
        }
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::String(text) => write_string(out, text),
        Value::Number(number) => out.push_str(&number_text(number)),
    }
}

/// Escape a string exactly as ECMAScript's JSON.stringify does.
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
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Write a number the way ECMAScript's Number::toString does, from its shortest round-trip digits.
fn number_text(number: &Number) -> String {
    if let Some(integer) = number.as_i64() {
        return integer.to_string();
    }
    if let Some(integer) = number.as_u64() {
        return integer.to_string();
    }
    let value = number
        .as_f64()
        .expect("a JSON number is an integer or a float");
    if value == 0.0 {
        return "0".to_owned();
    }
    // `{:e}` gives the shortest digits that round-trip, as d.ddde±x.
    let scientific = format!("{:e}", value.abs());
    let (mantissa, exponent) = scientific
        .split_once('e')
        .expect("`{:e}` always writes an exponent");
    let exponent: i32 = exponent.parse().expect("`{:e}` writes a decimal exponent");
    let digits = mantissa.replace('.', "");
    let digits = digits.trim_end_matches('0');
    let sign = if value < 0.0 { "-" } else { "" };
    format!("{sign}{}", layout(digits, exponent + 1))
}

/// Lay out `0.<digits> × 10^n` as ECMAScript does.
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
