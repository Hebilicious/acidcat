use acid_cat_core::cli::{CliOutput, OutputDefault, OutputForm, output_form};
use serde_json::Value;

const CASES: &str = include_str!("fixtures/cli_output_cases.json");

fn cases() -> Value {
    serde_json::from_str(CASES).expect("the cases of the model are JSON")
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .expect("a list of strings")
        .iter()
        .map(|each| each.as_str().expect("a string").to_owned())
        .collect()
}

fn form(value: &Value) -> OutputForm {
    match value.as_str() {
        Some("human") => OutputForm::Human,
        Some("json") => OutputForm::Json,
        _ => panic!("{value} is not a form"),
    }
}

fn with_flag(output: CliOutput, flag: &Value) -> CliOutput {
    let names = strings(&flag["names"]);
    match flag.get("values").and_then(Value::as_array) {
        Some(values) => output.values(
            names,
            values.iter().map(|pair| {
                let value = pair[0].as_str().expect("a value").to_owned();
                (value, form(&pair[1]))
            }),
        ),
        None => output.switch(names, form(&flag["form"])),
    }
}

fn output_of(flags: &Value) -> CliOutput {
    flags
        .as_array()
        .expect("a list of output flags")
        .iter()
        .fold(CliOutput::new(), with_flag)
}

fn env_of(case: &Value) -> impl Fn(&str) -> Option<String> {
    let env = case["env"].as_object().expect("an environment").clone();
    move |name| env.get(name).and_then(Value::as_str).map(str::to_owned)
}

#[test]
fn the_automatic_form_gives_the_form_of_the_model_in_each_case() {
    for case in cases()["auto"].as_array().expect("a list of cases") {
        let actual = output_form(case["isTerminal"] == Value::Bool(true), env_of(case));
        assert_eq!(actual, form(&case["form"]), "{case}");
    }
}

#[test]
fn the_check_of_the_output_flags_gives_the_messages_of_the_model_in_each_case() {
    let cases = cases();
    let others: Vec<(String, String)> = cases["problems"]["others"]
        .as_array()
        .expect("a list of other flags")
        .iter()
        .map(|other| {
            let pair = strings(other);
            (pair[0].clone(), pair[1].clone())
        })
        .collect();
    for case in cases["problems"]["cases"]
        .as_array()
        .expect("a list of cases")
    {
        let output = output_of(&case["flags"]);
        assert_eq!(
            output.problems(&others),
            strings(&case["messages"]),
            "{case}"
        );
    }
}

#[test]
fn the_output_flags_in_the_arguments_give_the_form_the_arguments_or_the_error_of_the_model_in_each_case()
 {
    let cases = cases();
    let output = output_of(&cases["choices"]["flags"]);
    for case in cases["choices"]["cases"]
        .as_array()
        .expect("a list of cases")
    {
        let commands = strings(&case["commands"]);
        let commands: Vec<&str> = commands.iter().map(String::as_str).collect();
        let expected = match case.get("error").and_then(Value::as_str) {
            Some(error) => Err(error.to_owned()),
            None => Ok((
                case.get("form").filter(|form| !form.is_null()).map(form),
                strings(&case["rest"]),
            )),
        };
        assert_eq!(
            output.choose(&strings(&case["args"]), &commands),
            expected,
            "{case}"
        );
    }
}

#[test]
fn the_output_flag_the_default_and_the_automatic_form_give_the_form_or_the_exit_code_of_the_model_in_each_case()
 {
    let cases = cases();
    let flags = &cases["decisions"]["flags"];
    for case in cases["decisions"]["cases"]
        .as_array()
        .expect("a list of cases")
    {
        let default = match case["default"].as_str() {
            Some("auto") => OutputDefault::Auto,
            _ => OutputDefault::Json,
        };
        let output = output_of(flags).default_form(default);
        let is_terminal = case["isTerminal"] == Value::Bool(true);
        let expected = match case.get("error").and_then(Value::as_str) {
            Some(error) => Err((
                i32::try_from(case["exitCode"].as_i64().expect("an exit code"))
                    .expect("an exit code of 32 bits"),
                error.to_owned(),
            )),
            None => Ok((form(&case["form"]), strings(&case["rest"]))),
        };
        let actual = output.decide(&strings(&case["args"]), &[], || {
            output_form(is_terminal, env_of(case))
        });
        assert_eq!(actual, expected, "{case}");
    }
}

#[test]
fn the_help_of_each_output_flag_is_the_line_of_the_model() {
    for case in cases()["help"].as_array().expect("a list of cases") {
        let output = with_flag(CliOutput::new(), &case["flag"]);
        assert_eq!(
            output.help_lines(),
            vec![case["line"].as_str().expect("a line").to_owned()],
            "{case}"
        );
    }
}
