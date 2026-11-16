use std::cell::Cell;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Once};

use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use crate::app::{CapabilityDefinition, EventDefinition};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum OutputForm {
    #[default]
    Json,
    Human,
}

const AGENT_VARIABLES: [&str; 12] = [
    "AI_AGENT",
    "CLAUDECODE",
    "CODEX_THREAD_ID",
    "CURSOR_AGENT",
    "GEMINI_CLI",
    "OPENCODE",
    "AMP_CURRENT_THREAD_ID",
    "AUGMENT_AGENT",
    "QWEN_CODE_SESSION_ID",
    "PI_CODING_AGENT",
    "CRUSH",
    "COPILOT_AGENT",
];

fn is_truthy(value: Option<String>) -> bool {
    value.is_some_and(|value| {
        !matches!(
            value.trim().to_lowercase().as_str(),
            "" | "0" | "false" | "no" | "off"
        )
    })
}

/// The form of the output when the arguments do not give `--output`: [`OutputForm::Human`] only when standard output
/// is a terminal, `CI` is not truthy and no variable of a coding agent is truthy. `env` gives the value of an
/// environment variable.
pub fn output_form(is_terminal: bool, env: impl Fn(&str) -> Option<String>) -> OutputForm {
    let automated = std::iter::once("CI")
        .chain(AGENT_VARIABLES)
        .any(|name| is_truthy(env(name)));
    if is_terminal && !automated {
        OutputForm::Human
    } else {
        OutputForm::Json
    }
}

pub(crate) fn output_color(is_terminal: bool, env: impl Fn(&str) -> Option<String>) -> bool {
    is_terminal && env("NO_COLOR").is_none_or(|value| value.is_empty())
}

/// The styles and the table that a format gets. Without color, each style gives the text unchanged.
#[derive(Clone, Copy, Debug, Default)]
pub struct CliUi {
    color: bool,
}

impl CliUi {
    pub fn new(color: bool) -> Self {
        CliUi { color }
    }

    fn style(&self, text: &str, open: &str, close: &str) -> String {
        if self.color {
            format!("\x1b[{open}m{text}\x1b[{close}m")
        } else {
            text.to_owned()
        }
    }

    pub fn bold(&self, text: &str) -> String {
        self.style(text, "1", "22")
    }

    pub fn dim(&self, text: &str) -> String {
        self.style(text, "2", "22")
    }

    /// Green.
    pub fn ok(&self, text: &str) -> String {
        self.style(text, "32", "39")
    }

    /// Yellow.
    pub fn warn(&self, text: &str) -> String {
        self.style(text, "33", "39")
    }

    /// Red.
    pub fn error(&self, text: &str) -> String {
        self.style(text, "31", "39")
    }

    /// A table: the header is the first row. Two spaces separate the columns, and each column has the width of its
    /// widest cell.
    pub fn table<H: AsRef<str>, R: AsRef<str>>(&self, header: &[H], rows: &[Vec<R>]) -> String {
        let header: Vec<&str> = header.iter().map(AsRef::as_ref).collect();
        let rows: Vec<Vec<&str>> = rows
            .iter()
            .map(|row| row.iter().map(AsRef::as_ref).collect())
            .collect();
        table(&header, &rows).join("\n")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Formatted {
    Value,
    Failure,
    Payload,
}

type Formatter = Arc<dyn Fn(&Value, &CliUi) -> Option<String> + Send + Sync>;

#[derive(Clone)]
struct Format {
    of: Formatted,
    id: String,
    format: Formatter,
}

/// The formats of the human form of the output, for the values and the failures of capabilities and the payloads of
/// events. Give them to [`CliOptions::formats`](super::CliOptions::formats).
///
/// A format gets the value decoded again from its JSON form with `serde_json::from_value`, so its type is the type of
/// the definition:
///
/// ```
/// # use acid_cat_core::{Capability, fail, cli::CliFormats};
/// # #[derive(serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
/// # struct Status { power: bool }
/// # #[derive(serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
/// # #[serde(tag = "_tag")]
/// # enum Offline { Offline {} }
/// let status_get = Capability::<()>::new("status.get", "Get the status.")
///     .output::<Status>()
///     .failures::<Offline>()
///     .run(|(), _| async { Ok(Status { power: true }) });
/// CliFormats::new()
///     .capability(&status_get, |status: &Status, ui| ui.bold(if status.power { "on" } else { "off" }))
///     .failure(&status_get, |failure: &Offline, ui| match failure {
///         Offline::Offline {} => ui.error("offline"),
///     });
/// ```
///
/// A format with another type does not build:
///
/// ```compile_fail
/// # use acid_cat_core::{Capability, cli::CliFormats};
/// # #[derive(serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
/// # struct Status { power: bool }
/// let status_get = Capability::<()>::new("status.get", "Get the status.")
///     .output::<Status>()
///     .run(|(), _| async { Ok(Status { power: true }) });
/// CliFormats::new().capability(&status_get, |status: &String, _| status.clone());
/// ```
///
/// ```compile_fail
/// # use acid_cat_core::{Event, Emitted, cli::CliFormats};
/// # #[derive(serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
/// # struct Status { power: bool }
/// let changed = Event::<()>::new("status.changed", "The status changed.")
///     .payload::<Status>()
///     .subscribe(|(), _| futures::stream::iter([Ok(Emitted::new(Status { power: true }))]));
/// CliFormats::new().event(&changed, |status: &Status, _| status.powr.to_string());
/// ```
#[derive(Clone, Default)]
pub struct CliFormats {
    formats: Vec<Format>,
    problems: Vec<String>,
}

impl CliFormats {
    pub fn new() -> Self {
        Self::default()
    }

    fn add<T: DeserializeOwned>(
        mut self,
        of: Formatted,
        id: &str,
        format: impl Fn(&T, &CliUi) -> String + Send + Sync + 'static,
    ) -> Self {
        if self
            .formats
            .iter()
            .any(|each| each.of == of && each.id == id)
        {
            let what = match of {
                Formatted::Value => "the value",
                Formatted::Failure => "the failures",
                Formatted::Payload => "the payload",
            };
            self.problems.push(format!(
                "The command line has two formats for {what} of {id}."
            ));
        }
        self.formats.push(Format {
            of,
            id: id.to_owned(),
            format: Arc::new(move |value, ui| {
                let decoded = serde_json::from_value::<T>(value.clone()).ok()?;
                Some(format(&decoded, ui))
            }),
        });
        self
    }

    pub fn capability<C, X, O: DeserializeOwned, F>(
        self,
        capability: &CapabilityDefinition<C, X, O, F>,
        format: impl Fn(&O, &CliUi) -> String + Send + Sync + 'static,
    ) -> Self {
        self.add(Formatted::Value, &capability.id, format)
    }

    pub fn failure<C, X, O, F: DeserializeOwned>(
        self,
        capability: &CapabilityDefinition<C, X, O, F>,
        format: impl Fn(&F, &CliUi) -> String + Send + Sync + 'static,
    ) -> Self {
        self.add(Formatted::Failure, &capability.id, format)
    }

    pub fn event<C, X, P: DeserializeOwned>(
        self,
        event: &EventDefinition<C, X, P>,
        format: impl Fn(&P, &CliUi) -> String + Send + Sync + 'static,
    ) -> Self {
        self.add(Formatted::Payload, &event.id, format)
    }

    pub(crate) fn problems(
        &self,
        target: &str,
        capability_ids: &[String],
        event_ids: &[String],
    ) -> Vec<String> {
        let mut problems = self.problems.clone();
        for format in &self.formats {
            let (ids, what) = match format.of {
                Formatted::Value | Formatted::Failure => (capability_ids, "a capability"),
                Formatted::Payload => (event_ids, "an event"),
            };
            if !ids.contains(&format.id) {
                problems.push(format!(
                    "The command line has a format for {}, which is not {what} in the view of the target {target}.",
                    format.id
                ));
            }
        }
        problems
    }

    pub(crate) fn render(&self, of: Formatted, id: &str, value: &Value, ui: &CliUi) -> String {
        let format = self
            .formats
            .iter()
            .find(|format| format.of == of && format.id == id);
        if let Some(format) = format
            && let Ok(Some(text)) = without_panic_message(|| (format.format)(value, ui))
        {
            return text;
        }
        layout(value)
    }
}

thread_local! {
    static IN_FORMAT: Cell<bool> = const { Cell::new(false) };
}

static QUIET_HOOK: Once = Once::new();

/// The panic hook runs before `catch_unwind` catches the panic, and the default hook writes the panic to standard
/// error. The hook that this installs skips the previous hook while the current thread is in a format.
fn without_panic_message<T>(call: impl FnOnce() -> T) -> std::thread::Result<T> {
    QUIET_HOOK.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            if !IN_FORMAT.get() {
                previous(info);
            }
        }));
    });
    let outer = IN_FORMAT.replace(true);
    let result = catch_unwind(AssertUnwindSafe(call));
    IN_FORMAT.set(outer);
    result
}

pub(crate) fn layout(value: &Value) -> String {
    if value.is_null() {
        return String::new();
    }
    lines(value).join("\n")
}

fn is_scalar(value: &Value) -> bool {
    !(value.is_array() || value.is_object())
}

fn is_one_line(value: &Value) -> bool {
    match value {
        Value::Array(items) => items.iter().all(is_scalar),
        Value::Object(_) => false,
        _ => true,
    }
}

fn scalar(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number_text(number),
        other => other.to_string(),
    }
}

/// The number as JSON text of JavaScript: a whole number has no fraction, and a number at or above 1e21, or below
/// 1e-6, has an exponent.
fn number_text(number: &serde_json::Number) -> String {
    if number.is_i64() || number.is_u64() {
        return number.to_string();
    }
    let Some(float) = number.as_f64() else {
        return number.to_string();
    };
    let size = float.abs();
    if size != 0.0 && !(1e-6..1e21).contains(&size) {
        let text = format!("{float:e}");
        match text.split_once('e') {
            Some((mantissa, exponent)) if !exponent.starts_with('-') => {
                format!("{mantissa}e+{exponent}")
            }
            _ => text,
        }
    } else {
        format!("{float}")
    }
}

fn lines(value: &Value) -> Vec<String> {
    match value {
        Value::Array(items) => array_lines(items),
        Value::Object(members) => object_lines(members),
        other => vec![scalar(other)],
    }
}

fn array_lines(items: &[Value]) -> Vec<String> {
    if items.is_empty() {
        return vec!["(none)".into()];
    }
    if items.iter().all(is_scalar) {
        return vec![items.iter().map(scalar).collect::<Vec<_>>().join(", ")];
    }
    let rows: Option<Vec<&Map<String, Value>>> = items
        .iter()
        .map(|item| item.as_object().filter(|row| row.values().all(is_one_line)))
        .collect();
    if let Some(rows) = rows {
        let mut columns: Vec<&str> = Vec::new();
        for key in rows.iter().flat_map(|row| row.keys()) {
            if !columns.contains(&key.as_str()) {
                columns.push(key);
            }
        }
        let cells: Vec<Vec<String>> = rows
            .iter()
            .map(|row| {
                columns
                    .iter()
                    .map(|column| {
                        row.get(*column)
                            .map(|cell| lines(cell).join("\n"))
                            .unwrap_or_default()
                    })
                    .collect()
            })
            .collect();
        let cells: Vec<Vec<&str>> = cells
            .iter()
            .map(|row| row.iter().map(String::as_str).collect())
            .collect();
        return table(&columns, &cells);
    }
    items
        .iter()
        .flat_map(|item| {
            lines(item).into_iter().enumerate().map(|(index, line)| {
                let prefix = if index == 0 { "- " } else { "  " };
                format!("{prefix}{line}").trim_end().to_owned()
            })
        })
        .collect()
}

fn object_lines(members: &Map<String, Value>) -> Vec<String> {
    if members.is_empty() {
        return vec!["(empty)".into()];
    }
    let key_width = members
        .iter()
        .filter(|(_, value)| is_one_line(value))
        .map(|(key, _)| width(key))
        .max()
        .unwrap_or(0);
    let mut result = Vec::new();
    for (key, value) in members {
        if is_one_line(value) {
            let padding = " ".repeat(key_width - width(key));
            result.push(
                format!("{key}{padding}  {}", lines(value).join(" "))
                    .trim_end()
                    .to_owned(),
            );
        } else {
            result.push(format!("{key}:"));
            result.extend(
                lines(value)
                    .into_iter()
                    .map(|line| format!("  {line}").trim_end().to_owned()),
            );
        }
    }
    result
}

fn table(header: &[&str], rows: &[Vec<&str>]) -> Vec<String> {
    let all: Vec<&[&str]> = std::iter::once(header)
        .chain(rows.iter().map(|row| &row[..row.len().min(header.len())]))
        .collect();
    aligned(&all)
}

/// The width of a text in UTF-16 code units, as the TypeScript cores measure it with `length`.
fn width(text: &str) -> usize {
    text.encode_utf16().count()
}

pub(crate) fn aligned(all: &[&[&str]]) -> Vec<String> {
    let columns = all.iter().map(|row| row.len()).max().unwrap_or(0);
    let widths: Vec<usize> = (0..columns)
        .map(|column| {
            all.iter()
                .map(|row| row.get(column).map_or(0, |cell| width(cell)))
                .max()
                .unwrap_or(0)
        })
        .collect();
    all.iter()
        .map(|row| {
            let cells: Vec<String> = widths
                .iter()
                .enumerate()
                .map(|(column, column_width)| {
                    let cell = row.get(column).copied().unwrap_or("");
                    format!("{cell}{}", " ".repeat(column_width - width(cell)))
                })
                .collect();
            cells.join("  ").trim_end().to_owned()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn output_form_is_human_only_in_a_terminal_with_no_ci_and_no_agent() {
        let with = |variables: &'static [(&'static str, &'static str)]| {
            move |name: &str| {
                variables
                    .iter()
                    .find(|(each, _)| *each == name)
                    .map(|(_, value)| (*value).to_owned())
            }
        };
        assert_eq!(output_form(true, with(&[])), OutputForm::Human);
        assert_eq!(
            output_form(true, with(&[("CLAUDECODE", "1")])),
            OutputForm::Json
        );
        assert_eq!(output_form(true, with(&[("CI", "true")])), OutputForm::Json);
        assert_eq!(
            output_form(true, with(&[("CLAUDECODE", "0")])),
            OutputForm::Human
        );
        assert_eq!(output_form(false, with(&[])), OutputForm::Json);
    }

    #[test]
    fn the_generic_layout_writes_objects_tables_and_lists() {
        let value = json!({
            "name": "unit",
            "on": true,
            "target": 22.0,
            "tags": ["a", "b"],
            "empty": [],
            "location": { "room": "living", "floor": 1, "nested": { "deep": null } },
            "readings": [
                { "at": "07:00", "celsius": 21.5 },
                { "at": "08:00", "note": "warm", "celsius": 23 }
            ],
            "mixed": [1, { "a": 1, "bb": [2, 3] }, [4, [5]]],
            "nothing": {},
            "glyphs": [{ "name": "😀😀", "n": 1 }, { "name": "ab", "n": 2 }],
            "notes": [{ "label": "a", "note": null }]
        });
        assert_eq!(
            layout(&value),
            [
                "name    unit",
                "on      true",
                "target  22",
                "tags    a, b",
                "empty   (none)",
                "location:",
                "  room   living",
                "  floor  1",
                "  nested:",
                "    deep  null",
                "readings:",
                "  at     celsius  note",
                "  07:00  21.5",
                "  08:00  23       warm",
                "mixed:",
                "  - 1",
                "  - a   1",
                "    bb  2, 3",
                "  - - 4",
                "    - 5",
                "nothing:",
                "  (empty)",
                "glyphs:",
                "  name  n",
                "  😀😀  1",
                "  ab    2",
                "notes:",
                "  label  note",
                "  a      null",
            ]
            .join("\n")
        );
        assert_eq!(layout(&Value::Null), "");
        assert_eq!(
            CliUi::new(false).table(&["h"], &[vec!["😀😀", "x"], vec!["ab", "y"]]),
            "h\n😀😀\nab"
        );
    }
}
