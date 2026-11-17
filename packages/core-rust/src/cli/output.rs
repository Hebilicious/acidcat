use super::human::{CliFormats, OutputForm};

/// The form of the output when the arguments give no output flag.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum OutputDefault {
    /// The human form when standard output is a terminal and no CI and no coding agent is detected (see
    /// [`output_form`](super::output_form)), and JSON in all other cases.
    #[default]
    Auto,
    Human,
    Json,
}

#[derive(Clone, Debug)]
enum Choice {
    Form(OutputForm),
    Values(Vec<(String, OutputForm)>),
}

#[derive(Clone, Debug)]
struct OutputFlag {
    names: Vec<String>,
    choice: Choice,
}

/// The human form of the output. Give it to [`CliOptions::output`](super::CliOptions::output). Without it, the
/// command line writes JSON only, and takes no output flag.
///
/// The output flags can be anywhere in the arguments. When the arguments give more than one, the last one wins. Each
/// name is `--word` or `-x`, with one letter or digit.
///
/// ```
/// # use acid_cat_core::cli::{CliOutput, OutputForm};
/// CliOutput::new()
///     .values(["--format", "-f"], [("text", OutputForm::Human), ("json", OutputForm::Json)])
///     .switch(["--json"], OutputForm::Json);
/// ```
#[derive(Clone, Default)]
pub struct CliOutput {
    flags: Vec<OutputFlag>,
    pub(crate) default: OutputDefault,
    pub(crate) formats: CliFormats,
}

impl CliOutput {
    pub fn new() -> Self {
        Self::default()
    }

    /// A flag with no value that chooses `form`, for example `--json`.
    pub fn switch<N: Into<String>>(
        mut self,
        names: impl IntoIterator<Item = N>,
        form: OutputForm,
    ) -> Self {
        self.flags.push(OutputFlag {
            names: names.into_iter().map(Into::into).collect(),
            choice: Choice::Form(form),
        });
        self
    }

    /// A flag with a value, and the form of each value. `values(["--format"], [("text", OutputForm::Human)])` takes
    /// `--format text` and `--format=text`. A short name takes `-f text`.
    pub fn values<N: Into<String>, V: Into<String>>(
        mut self,
        names: impl IntoIterator<Item = N>,
        values: impl IntoIterator<Item = (V, OutputForm)>,
    ) -> Self {
        self.flags.push(OutputFlag {
            names: names.into_iter().map(Into::into).collect(),
            choice: Choice::Values(
                values
                    .into_iter()
                    .map(|(value, form)| (value.into(), form))
                    .collect(),
            ),
        });
        self
    }

    /// The form when the arguments give no output flag. The default is [`OutputDefault::Auto`].
    pub fn default_form(mut self, default: OutputDefault) -> Self {
        self.default = default;
        self
    }

    pub fn formats(mut self, formats: CliFormats) -> Self {
        self.formats = formats;
        self
    }

    pub(crate) fn problems(&self, other_flags: &[(String, String)]) -> Vec<String> {
        let mut problems = Vec::new();
        let mut seen: Vec<&str> = Vec::new();
        for flag in &self.flags {
            let first = flag.names.first();
            if first.is_none() {
                problems.push("An output flag has no name.".to_owned());
            }
            for name in &flag.names {
                if !is_long_name(name) && !is_short_name(name) {
                    problems.push(format!(
                        "The output flag {name} is not a valid name. Give --<word> or -<letter or digit>."
                    ));
                    continue;
                }
                if seen.contains(&name.as_str()) {
                    problems.push(format!(
                        "The output flag {name} has the same name as another output flag."
                    ));
                }
                seen.push(name);
                if let Some((_, other)) = other_flags.iter().find(|(other, _)| other == name) {
                    problems.push(format!(
                        "The output flag {name} has the same name as {other}."
                    ));
                }
            }
            if let (Some(first), Choice::Values(values)) = (first, &flag.choice)
                && values.is_empty()
            {
                problems.push(format!("The output flag {first} has no values."));
            }
        }
        problems
    }

    pub(crate) fn choose(
        &self,
        args: &[String],
    ) -> Result<(Option<OutputForm>, Vec<String>), String> {
        let mut rest = Vec::new();
        let mut form = None;
        let mut items = args.iter();
        while let Some(arg) = items.next() {
            let (name, inline) = match arg.split_once('=') {
                Some((name, inline)) if arg.starts_with("--") => (name, Some(inline)),
                _ => (arg.as_str(), None),
            };
            let flag = self
                .flags
                .iter()
                .find(|flag| flag.names.iter().any(|each| each == name));
            match flag.map(|flag| &flag.choice) {
                Some(Choice::Form(chosen)) if inline.is_none() => form = Some(*chosen),
                Some(Choice::Values(values)) => {
                    let value = inline.or_else(|| items.next().map(String::as_str));
                    let chosen = values
                        .iter()
                        .find(|(each, _)| Some(each.as_str()) == value)
                        .map(|(_, chosen)| *chosen);
                    let Some(chosen) = chosen else {
                        let words: Vec<&str> =
                            values.iter().map(|(value, _)| value.as_str()).collect();
                        return Err(format!("The option {name} must be {}.", choices(&words)));
                    };
                    form = Some(chosen);
                }
                _ => rest.push(arg.clone()),
            }
        }
        Ok((form, rest))
    }
}

fn choices(values: &[&str]) -> String {
    match values.split_last() {
        Some((last, others)) if !others.is_empty() => format!("{} or {last}", others.join(", ")),
        _ => values.join(""),
    }
}

fn is_long_name(name: &str) -> bool {
    let Some(word) = name.strip_prefix("--") else {
        return false;
    };
    word.starts_with(|first: char| first.is_ascii_lowercase())
        && word.split('-').all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        })
}

fn is_short_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next() == Some('-')
        && chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.next().is_none()
}
