use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use http::HeaderMap;
use serde_json::{Map, Value};

use crate::facts_generated::MCP_NAMED_METHODS;

const BASE64_PREFIX: &str = "=?base64?";
const BASE64_SUFFIX: &str = "?=";
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

#[derive(PartialEq)]
enum Header<'a> {
    Absent,
    Text(&'a str),
    NotText,
}

impl<'a> Header<'a> {
    fn read(headers: &'a HeaderMap, name: &str) -> Self {
        match headers.get(name) {
            None => Header::Absent,
            Some(value) => value.to_str().map_or(Header::NotText, Header::Text),
        }
    }

    fn decoded(&self) -> Option<String> {
        match self {
            Header::Text(text) => decode(text),
            Header::Absent | Header::NotText => None,
        }
    }
}

fn decode(value: &str) -> Option<String> {
    let sentinel = value.len() >= BASE64_PREFIX.len() + BASE64_SUFFIX.len()
        && value.starts_with(BASE64_PREFIX)
        && value.ends_with(BASE64_SUFFIX);
    if !sentinel {
        let plain = value
            .chars()
            .all(|character| character == '\t' || (' '..='~').contains(&character));
        return plain.then(|| value.to_owned());
    }
    let encoded = &value[BASE64_PREFIX.len()..value.len() - BASE64_SUFFIX.len()];
    String::from_utf8(STANDARD.decode(encoded).ok()?).ok()
}

fn header_properties(schema: &Value) -> Vec<(String, Vec<String>)> {
    let mut found = Vec::new();
    let mut pending = vec![(schema, Vec::new())];
    while let Some((schema, path)) = pending.pop() {
        let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
            continue;
        };
        for (name, property) in properties.iter().rev() {
            let mut path = path.clone();
            path.push(name.clone());
            if let Some(header) = property.get("x-mcp-header").and_then(Value::as_str) {
                found.push((header.to_owned(), path.clone()));
            }
            pending.push((property, path));
        }
    }
    found
}

fn argument_at<'a>(arguments: Option<&'a Value>, path: &[String]) -> Option<&'a Value> {
    path.iter()
        .try_fold(arguments?, |value, key| value.as_object()?.get(key))
}

fn agrees(header: Header, value: Option<&Value>) -> bool {
    let value = match value {
        None | Some(Value::Null) => return header == Header::Absent,
        Some(value) => value,
    };
    let Some(decoded) = header.decoded() else {
        return false;
    };
    match value {
        Value::String(text) => *text == decoded,
        Value::Bool(flag) => decoded == flag.to_string(),
        Value::Number(number) => number.as_f64().is_some_and(|number| {
            number.fract() == 0.0
                && number.abs() <= MAX_SAFE_INTEGER
                && !decoded.trim().is_empty()
                && decoded.trim().parse::<f64>().ok() == Some(number)
        }),
        _ => false,
    }
}

pub(crate) fn header_mismatch(
    headers: &HeaderMap,
    method: &str,
    params: &Map<String, Value>,
    input_schema: Option<&Value>,
) -> Option<String> {
    if Header::read(headers, "mcp-method") != Header::Text(method) {
        return Some("The Mcp-Method header does not agree with the method of the request.".into());
    }
    if MCP_NAMED_METHODS.contains(&method) {
        let name = params.get("name").and_then(Value::as_str);
        let decoded = Header::read(headers, "mcp-name").decoded();
        if name.is_none() || decoded.as_deref() != name {
            return Some("The Mcp-Name header does not agree with params.name.".into());
        }
    }
    let properties = input_schema.map(header_properties).unwrap_or_default();
    for (name, path) in properties {
        let value = argument_at(params.get("arguments"), &path);
        if !agrees(Header::read(headers, &format!("mcp-param-{name}")), value) {
            return Some(format!(
                "The Mcp-Param-{name} header does not agree with params.arguments.{}.",
                path.join(".")
            ));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in pairs {
            headers.insert(
                http::HeaderName::from_bytes(name.as_bytes()).expect("a header name"),
                http::HeaderValue::from_str(value).expect("a header value"),
            );
        }
        headers
    }

    #[test]
    fn values_decode_as_the_examples_of_the_streamable_http_transport_show() {
        for (encoded, text) in [
            ("us-west1", "us-west1"),
            ("=?base64?SGVsbG8sIOS4lueVjA==?=", "Hello, 世界"),
            ("=?base64?IHBhZGRlZCA=?=", " padded "),
            ("=?base64?bGluZTEKbGluZTI=?=", "line1\nline2"),
            ("=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=", "=?base64?literal?="),
            ("=?base64?77u/aw==?=", "\u{feff}k"),
        ] {
            assert_eq!(decode(encoded).as_deref(), Some(text), "{encoded}");
        }
        for invalid in ["=?base64?not base64?=", "=?base64?/w==?="] {
            assert_eq!(decode(invalid), None, "{invalid}");
        }
    }

    #[test]
    fn the_param_headers_must_agree_with_nested_and_integer_arguments() {
        let schema = json!({
            "type": "object",
            "properties": {
                "region": { "type": "string", "x-mcp-header": "Region" },
                "nested": { "type": "object", "properties": { "on": { "type": "boolean", "x-mcp-header": "On" } } },
                "count": { "type": "integer", "x-mcp-header": "Count" },
                "list": { "type": "array", "items": { "type": "object", "properties": { "ignored": { "type": "string", "x-mcp-header": "Ignored" } } } },
            },
        });
        let check = |extra: &[(&str, &str)], arguments: Value| {
            let params = Map::from_iter([
                ("name".to_owned(), json!("db.query")),
                ("arguments".to_owned(), arguments),
            ]);
            let named = [("mcp-method", "tools/call"), ("mcp-name", "db.query")];
            let pairs = [named.as_slice(), extra].concat();
            header_mismatch(&headers(&pairs), "tools/call", &params, Some(&schema))
        };
        assert_eq!(
            check(
                &[("Mcp-Param-Region", "eu"), ("mcp-param-count", "42")],
                json!({ "region": "eu", "count": 42 })
            ),
            None
        );
        assert_eq!(
            check(
                &[("Mcp-Param-On", "true")],
                json!({ "nested": { "on": true } })
            ),
            None
        );
        let mismatch = |extra: &[(&str, &str)], arguments: Value, header: &str| {
            let reason = check(extra, arguments).unwrap_or_default();
            assert!(reason.contains(header), "{reason} names {header}");
        };
        mismatch(&[("Mcp-Param-Region", "eu")], json!({}), "Mcp-Param-Region");
        mismatch(
            &[("Mcp-Param-Count", "4x")],
            json!({ "count": 4 }),
            "Mcp-Param-Count",
        );
    }
}
