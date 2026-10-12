//! Write an AcidCat catalog in Rust, and render it to the JSON document the toolchain checks.
//!
//! This is an authoring library, not a runtime: a program uses it to produce `acidcat.catalog.json`, and nothing
//! reads the catalog through it at runtime. See spec/catalog.md.

mod canonical;

pub use canonical::canonical_text;

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};

/// A JSON Schema 2020-12 schema, written with `serde_json::json!`.
pub type Schema = Value;

static ID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[a-z][a-z0-9]*(-[a-z0-9]+)*(\.[a-z][a-z0-9]*(-[a-z0-9]+)*)+$").unwrap()
});
static NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)?$").unwrap());
static TYPE_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z][A-Za-z0-9_]*$").unwrap());
static REFERENCE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^#/\$defs/([A-Za-z][A-Za-z0-9_]*)$").unwrap());

/// How a target is served.
#[derive(Clone, Debug, Default)]
pub struct Target {
    /// The bindings that serve the target, such as `"typescript"` and `"webmcp"`.
    pub bindings: Vec<String>,
    pub description: Option<String>,
    /// Settings for the bindings, in a form each binding defines.
    pub options: Option<Value>,
}

/// One capability.
#[derive(Clone, Debug, Default)]
pub struct Capability {
    /// What the capability does for its caller, written for people and agents.
    pub description: String,
    /// The targets the capability is offered to. Empty means no target.
    pub audience: Vec<String>,
    /// The input schema. It must describe an object. `None` means an empty object.
    pub input: Option<Schema>,
    /// The schema of a successful call's value. `None` means `null`.
    pub output: Option<Schema>,
    /// The failures, keyed by tag, in the order they are written.
    pub failures: Vec<(String, Schema)>,
    /// `true` when a call changes nothing anyone can observe. A hint for clients.
    pub read_only: bool,
    /// The schema of a value that clients can observe.
    pub state: Option<Schema>,
}

/// A catalog being written.
#[derive(Debug, Default)]
pub struct Catalog {
    title: Option<String>,
    description: Option<String>,
    targets: Vec<(String, Target)>,
    types: Vec<(String, Schema)>,
    capabilities: Vec<(String, Capability)>,
    duplicates: Vec<String>,
}

impl Catalog {
    /// Start a catalog.
    pub fn new(title: Option<&str>, description: Option<&str>) -> Self {
        Self {
            title: title.map(str::to_owned),
            description: description.map(str::to_owned),
            ..Self::default()
        }
    }

    /// Declare a target.
    pub fn target(&mut self, name: &str, target: Target) -> &mut Self {
        if self.targets.iter().any(|(existing, _)| existing == name) {
            self.duplicates
                .push(format!("the target {name} is declared twice"));
        }
        self.targets.push((name.to_owned(), target));
        self
    }

    /// Declare a shared type, and get the schema that references it.
    pub fn r#type(&mut self, name: &str, schema: Schema) -> Schema {
        if self.type_named(name).is_some() {
            self.duplicates
                .push(format!("the type {name} is declared twice"));
        }
        self.types.push((name.to_owned(), schema));
        json!({ "$ref": format!("#/$defs/{name}") })
    }

    /// Declare a capability.
    pub fn capability(&mut self, id: &str, capability: Capability) -> &mut Self {
        if self.capabilities.iter().any(|(existing, _)| existing == id) {
            self.duplicates
                .push(format!("the capability {id} is declared twice"));
        }
        self.capabilities.push((id.to_owned(), capability));
        self
    }

    /// The catalog rules this catalog breaks. Empty when it conforms.
    pub fn validate(&self) -> Vec<String> {
        let mut problems = self.duplicates.clone();
        for (name, target) in &self.targets {
            if !NAME.is_match(name) {
                problems.push(format!("the target name {name} is malformed"));
            }
            if target.bindings.is_empty() {
                problems.push(format!("the target {name} has no bindings"));
            }
            if has_repeat(&target.bindings) {
                problems.push(format!("the target {name} repeats a binding"));
            }
            for binding in target
                .bindings
                .iter()
                .filter(|binding| !NAME.is_match(binding))
            {
                problems.push(format!(
                    "the target {name} names the malformed binding {binding}"
                ));
            }
        }
        for (name, schema) in &self.types {
            if !TYPE_NAME.is_match(name) {
                problems.push(format!("the type name {name} is malformed"));
            }
            for problem in self.reference_problems(schema) {
                problems.push(format!("the type {name} {problem}"));
            }
        }
        for (id, capability) in &self.capabilities {
            if id.len() > 128 || !ID.is_match(id) {
                problems.push(format!("the id {id} is malformed"));
            }
            if capability.description.trim().is_empty() {
                problems.push(format!("{id} has no description"));
            }
            if has_repeat(&capability.audience) {
                problems.push(format!("{id} repeats a target in its audience"));
            }
            for target in &capability.audience {
                if !self.targets.iter().any(|(name, _)| name == target) {
                    problems.push(format!("{id} names the undeclared target {target}"));
                }
            }
            if let Some(input) = &capability.input
                && self.resolve(input).get("type") != Some(&json!("object"))
            {
                problems.push(format!("{id} input does not describe an object"));
            }
            let schemas = [&capability.input, &capability.output, &capability.state];
            let failures = capability.failures.iter().map(|(_, schema)| schema);
            for schema in schemas.into_iter().flatten().chain(failures) {
                for problem in self.reference_problems(schema) {
                    problems.push(format!("{id} {problem}"));
                }
            }
        }
        problems
    }

    /// The catalog as a JSON value, or the rules it breaks.
    pub fn to_json(&self) -> Result<Value, Vec<String>> {
        let problems = self.validate();
        if !problems.is_empty() {
            return Err(problems);
        }
        let mut document = Map::new();
        document.insert("acidcat".into(), json!("0.1"));
        insert_some(&mut document, "title", self.title.clone().map(Value::from));
        insert_some(
            &mut document,
            "description",
            self.description.clone().map(Value::from),
        );

        let mut targets = Map::new();
        for (name, target) in &self.targets {
            let mut out = Map::new();
            out.insert("bindings".into(), json!(target.bindings));
            insert_some(
                &mut out,
                "description",
                target.description.clone().map(Value::from),
            );
            insert_some(&mut out, "options", target.options.clone());
            targets.insert(name.clone(), Value::Object(out));
        }
        document.insert("targets".into(), Value::Object(targets));

        if !self.types.is_empty() {
            let types = self
                .types
                .iter()
                .map(|(name, schema)| (name.clone(), schema.clone()))
                .collect();
            document.insert("$defs".into(), Value::Object(types));
        }

        let mut capabilities = Map::new();
        for (id, capability) in &self.capabilities {
            let mut out = Map::new();
            out.insert("description".into(), json!(capability.description));
            out.insert("audience".into(), json!(capability.audience));
            insert_some(&mut out, "input", capability.input.clone());
            insert_some(&mut out, "output", capability.output.clone());
            if !capability.failures.is_empty() {
                let failures = capability
                    .failures
                    .iter()
                    .map(|(tag, schema)| (tag.clone(), schema.clone()))
                    .collect();
                out.insert("failures".into(), Value::Object(failures));
            }
            if capability.read_only {
                out.insert("readOnly".into(), json!(true));
            }
            insert_some(&mut out, "state", capability.state.clone());
            capabilities.insert(id.clone(), Value::Object(out));
        }
        document.insert("capabilities".into(), Value::Object(capabilities));
        Ok(Value::Object(document))
    }

    /// The catalog as JSON text in canonical form, ready to write to `acidcat.catalog.json`, or the rules it breaks.
    pub fn render(&self) -> Result<String, Vec<String>> {
        Ok(canonical_text(&self.to_json()?))
    }

    fn type_named(&self, name: &str) -> Option<&Schema> {
        self.types
            .iter()
            .find(|(existing, _)| existing == name)
            .map(|(_, schema)| schema)
    }

    fn resolve<'a>(&'a self, schema: &'a Schema) -> &'a Schema {
        schema
            .get("$ref")
            .and_then(Value::as_str)
            .and_then(|reference| REFERENCE.captures(reference))
            .and_then(|captures| self.type_named(&captures[1]))
            .unwrap_or(schema)
    }

    fn reference_problems(&self, schema: &Value) -> Vec<String> {
        let mut problems = Vec::new();
        visit(schema, &mut |node| {
            if node.contains_key("$defs") {
                problems
                    .push("carries its own $defs; declare shared types with r#type()".to_owned());
            }
            if let Some(reference) = node.get("$ref") {
                let known = reference
                    .as_str()
                    .and_then(|text| REFERENCE.captures(text))
                    .is_some_and(|captures| self.type_named(&captures[1]).is_some());
                if !known {
                    let text = reference
                        .as_str()
                        .map_or_else(|| reference.to_string(), str::to_owned);
                    problems.push(format!("references {text}, which is not a type"));
                }
            }
        });
        problems
    }
}

fn insert_some(object: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        object.insert(key.to_owned(), value);
    }
}

fn has_repeat(values: &[String]) -> bool {
    let mut seen = HashSet::new();
    values.iter().any(|value| !seen.insert(value))
}

fn visit(value: &Value, on_object: &mut impl FnMut(&Map<String, Value>)) {
    match value {
        Value::Object(object) => {
            on_object(object);
            object.values().for_each(|inner| visit(inner, on_object));
        }
        Value::Array(items) => items.iter().for_each(|item| visit(item, on_object)),
        _ => {}
    }
}
