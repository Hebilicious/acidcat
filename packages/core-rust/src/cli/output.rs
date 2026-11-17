use super::human::{CliFormats, OutputForm};
use super::output_generated::{
    AND_WORD, BAD_NAME_MESSAGE, BAD_VALUE_MESSAGE, HUMAN_FORM_NAME, INVALID_INPUT_EXIT_CODE,
    JSON_FORM_NAME, LIST_SEPARATOR, MEANING_MESSAGE, NAME_SEPARATOR, NO_NAME_MESSAGE,
    NO_VALUES_MESSAGE, OR_WORD, SAME_AS_OTHER_MESSAGE, SAME_AS_OUTPUT_FLAG_MESSAGE,
    SWITCH_HELP_MESSAGE, VALUE_SEPARATOR, VALUES_HELP_MESSAGE,
};

/// The form of the output when the arguments give no output flag.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum OutputDefault {
    /// The human form when standard output is a terminal and no CI and no coding agent is detected (see
    /// [`output_form`](super::output_form)), and JSON in all other cases.
    Auto,
    #[default]
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

    /// The form when the arguments give no output flag. The default is [`OutputDefault::Json`].
    pub fn default_form(mut self, default: OutputDefault) -> Self {
        self.default = default;
        self
    }

    pub fn formats(mut self, formats: CliFormats) -> Self {
        self.formats = formats;
        self
    }

    /// The problems of the output flags, with the other flags of the command line and what each one is.
    #[doc(hidden)]
    pub fn problems(&self, other_flags: &[(String, String)]) -> Vec<String> {
        let mut problems = Vec::new();
        let mut seen: Vec<&str> = Vec::new();
        for flag in &self.flags {
            let first = flag.names.first();
            if first.is_none() {
                problems.push(NO_NAME_MESSAGE.to_owned());
            }
            for name in &flag.names {
                if !is_long_name(name) && !is_short_name(name) {
                    problems.push(filled(BAD_NAME_MESSAGE, &[("name", name)]));
                    continue;
                }
                if seen.contains(&name.as_str()) {
                    problems.push(filled(SAME_AS_OUTPUT_FLAG_MESSAGE, &[("name", name)]));
                }
                seen.push(name);
                if let Some((_, other)) = other_flags.iter().find(|(other, _)| other == name) {
                    problems.push(filled(
                        SAME_AS_OTHER_MESSAGE,
                        &[("name", name), ("other", other)],
                    ));
                }
            }
            if let (Some(first), Choice::Values(values)) = (first, &flag.choice)
                && values.is_empty()
            {
                problems.push(filled(NO_VALUES_MESSAGE, &[("name", first)]));
            }
        }
        problems
    }

    /// The line of the help of each output flag.
    #[doc(hidden)]
    pub fn help_lines(&self) -> Vec<String> {
        self.flags
            .iter()
            .map(|flag| {
                let names = flag.names.join(NAME_SEPARATOR);
                match &flag.choice {
                    Choice::Form(form) => filled(
                        SWITCH_HELP_MESSAGE,
                        &[("names", &names), ("form", form_name(*form))],
                    ),
                    Choice::Values(values) => {
                        let values = sorted(values);
                        let words: Vec<&str> = values.iter().map(|(value, _)| *value).collect();
                        let meanings: Vec<String> = values
                            .iter()
                            .map(|(value, form)| {
                                filled(
                                    MEANING_MESSAGE,
                                    &[("value", value), ("form", form_name(*form))],
                                )
                            })
                            .collect();
                        let meanings: Vec<&str> = meanings.iter().map(String::as_str).collect();
                        filled(
                            VALUES_HELP_MESSAGE,
                            &[
                                ("names", &names),
                                ("values", &words.join(VALUE_SEPARATOR)),
                                ("meanings", &joined(&meanings, AND_WORD)),
                            ],
                        )
                    }
                }
            })
            .collect()
    }

    /// The form and the remaining arguments, or the exit code and the message of a bad output flag. `auto` gives the
    /// form of [`OutputDefault::Auto`].
    #[doc(hidden)]
    pub fn decide(
        &self,
        args: &[String],
        command_names: &[&str],
        auto: impl FnOnce() -> OutputForm,
    ) -> Result<(OutputForm, Vec<String>), (i32, String)> {
        let (chosen, rest) = self
            .choose(args, command_names)
            .map_err(|message| (INVALID_INPUT_EXIT_CODE, message))?;
        let form = chosen.unwrap_or_else(|| match self.default {
            OutputDefault::Auto => auto(),
            OutputDefault::Json => OutputForm::Json,
        });
        Ok((form, rest))
    }

    /// The form that the output flags in the arguments choose, and the other arguments, or the message of a bad value.
    #[doc(hidden)]
    pub fn choose(
        &self,
        args: &[String],
        command_names: &[&str],
    ) -> Result<(Option<OutputForm>, Vec<String>), String> {
        let mut rest = Vec::new();
        let mut form = None;
        let mut items = args.iter();
        while let Some(arg) = items.next() {
            if arg == "--" || (rest.is_empty() && command_names.contains(&arg.as_str())) {
                rest.push(arg.clone());
                rest.extend(items.cloned());
                break;
            }
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
                            sorted(values).iter().map(|(value, _)| *value).collect();
                        return Err(filled(
                            BAD_VALUE_MESSAGE,
                            &[("name", name), ("values", &joined(&words, OR_WORD))],
                        ));
                    };
                    form = Some(chosen);
                }
                _ => rest.push(arg.clone()),
            }
        }
        Ok((form, rest))
    }
}

pub(super) fn filled(template: &str, parts: &[(&str, &str)]) -> String {
    let mut text = String::new();
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        let (before, from_brace) = rest.split_at(open);
        text.push_str(before);
        let part = from_brace.find('}').and_then(|close| {
            parts
                .iter()
                .find(|(name, _)| *name == &from_brace[1..close])
                .map(|(_, value)| (close, *value))
        });
        match part {
            Some((close, value)) => {
                text.push_str(value);
                rest = &from_brace[close + 1..];
            }
            None => {
                text.push('{');
                rest = &from_brace[1..];
            }
        }
    }
    text.push_str(rest);
    text
}

fn joined(values: &[&str], word: &str) -> String {
    match values.split_last() {
        Some((last, others)) if !others.is_empty() => {
            format!("{} {word} {last}", others.join(LIST_SEPARATOR))
        }
        _ => values.join(""),
    }
}

fn sorted(values: &[(String, OutputForm)]) -> Vec<(&str, OutputForm)> {
    let mut sorted: Vec<(&str, OutputForm)> = values
        .iter()
        .map(|(value, form)| (value.as_str(), *form))
        .collect();
    sorted.sort_by_key(|(left, _)| *left);
    sorted
}

fn form_name(form: OutputForm) -> &'static str {
    match form {
        OutputForm::Human => HUMAN_FORM_NAME,
        OutputForm::Json => JSON_FORM_NAME,
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
