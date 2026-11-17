use std::process::Command;
use std::sync::{Arc, Mutex};

use acid_cat_core::cli::{
    CliAliases, CliFormats, CliIo, CliOptions, CliOutput, OutputDefault, OutputForm, exit, run_cli,
};
use acid_cat_core::{App, Application, Capability, CapabilityDefinition, fail};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio_util::sync::CancellationToken;

#[derive(Deserialize, JsonSchema)]
struct Number {
    count: u32,
}

#[derive(Serialize, Deserialize)]
struct Count {
    #[serde(rename(serialize = "n", deserialize = "count"))]
    count: u32,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(tag = "_tag")]
enum Jammed {
    Jammed { at: u32 },
}

fn count() -> CapabilityDefinition<(), Number, Count> {
    Capability::new("probe.count", "Give the count.")
        .audience(["cli"])
        .input::<Number>()
        .output_schema::<Count>(json!({ "type": "object" }))
        .run(|Number { count }, _| async move { Ok(Count { count }) })
}

fn jam() -> CapabilityDefinition<(), acid_cat_core::NoInput, (), Jammed> {
    Capability::new("probe.jam", "Jam the probe.")
        .audience(["cli"])
        .failures::<Jammed>()
        .run(|(), _| async move { fail(Jammed::Jammed { at: 3 }) })
}

fn probe() -> Arc<Application<()>> {
    App::new()
        .target("cli", ["cli"])
        .cli_aliases("cli", CliAliases::new().alias("--jammed", &jam()))
        .capability(count())
        .capability(jam())
        .build()
        .unwrap_or_else(|problems| panic!("the application does not conform: {problems:?}"))
}

struct Ran {
    code: i32,
    stdout: String,
    stderr: String,
}

async fn run_with(
    output: Option<CliOutput>,
    args: &[&str],
    auto_form: Option<OutputForm>,
) -> Result<Ran, String> {
    let (stdout, stderr) = (
        Arc::new(Mutex::new(Vec::<String>::new())),
        Arc::new(Mutex::new(Vec::<String>::new())),
    );
    let (out, err) = (stdout.clone(), stderr.clone());
    let mut io = CliIo {
        stdout: Box::new(move |text| out.lock().unwrap().push(text.to_owned())),
        stderr: Box::new(move |text| err.lock().unwrap().push(text.to_owned())),
        cancel: CancellationToken::new(),
    };
    let mut options = CliOptions::new("probe", "0.0.0");
    options.output = output;
    options.auto_form = auto_form;
    let args: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
    let code = run_cli(&probe(), Arc::new(()), &options, &args, &mut io).await?;
    let (stdout, stderr) = (
        stdout.lock().unwrap().join("\n"),
        stderr.lock().unwrap().join("\n"),
    );
    Ok(Ran {
        code,
        stdout,
        stderr,
    })
}

async fn run(formats: CliFormats, args: &[&str]) -> Result<(i32, String), String> {
    let output = CliOutput::new()
        .default_form(OutputDefault::Human)
        .formats(formats);
    let ran = run_with(Some(output), args, None).await?;
    Ok((ran.code, format!("{}{}", ran.stdout, ran.stderr)))
}

const IN_CHILD: &str = "ACID_CAT_HUMAN_TEST_CHILD";

/// The default panic hook writes to standard error of the process, and the test harness captures it. So the test runs
/// again in a child process, and the parent reads standard error of the child.
#[test]
fn a_value_that_does_not_decode_and_a_format_that_panics_give_the_generic_layout() {
    let name = "a_value_that_does_not_decode_and_a_format_that_panics_give_the_generic_layout";
    if std::env::var_os(IN_CHILD).is_none() {
        let output = Command::new(std::env::current_exe().expect("the path of the test program"))
            .args(["--exact", name, "--nocapture"])
            .env(IN_CHILD, "1")
            .output()
            .expect("the test program runs");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(output.status.success(), "the child test fails: {stderr}");
        assert!(
            !stderr.contains("the format fails"),
            "standard error: {stderr}"
        );
        return;
    }
    let formats = || {
        CliFormats::new()
            .capability(&count(), |count: &Count, _| {
                format!("count {}", count.count)
            })
            .failure(&jam(), |_: &Jammed, _| panic!("the format fails"))
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .expect("a runtime");
    assert_eq!(
        runtime.block_on(run(formats(), &["probe", "count", "--count", "2"])),
        Ok((exit::VALUE, "n  2".into()))
    );
    assert_eq!(
        runtime.block_on(run(formats(), &["probe", "jam"])),
        Ok((exit::FAILURE, "_tag  Jammed\nat    3".into()))
    );
}

#[tokio::test]
async fn two_formats_for_one_value_stop_the_command_line_when_it_starts() {
    let formats = CliFormats::new()
        .capability(&count(), |_: &Count, _| "one".into())
        .capability(&count(), |_: &Count, _| "two".into());
    assert_eq!(
        run(formats, &["list"]).await,
        Err("The command line has two formats for the value of probe.count.".into())
    );
}

const COUNT_JSON: &str = "{\n  \"n\": 2\n}";

const COUNT_TEXT: &str = "n  2";

#[tokio::test]
async fn without_the_option_output_the_command_line_writes_json_and_output_is_an_unknown_argument()
{
    let json = run_with(
        None,
        &["probe", "count", "--count", "2"],
        Some(OutputForm::Human),
    )
    .await
    .unwrap();
    assert_eq!((json.code, json.stdout.as_str()), (exit::VALUE, COUNT_JSON));
    let unknown = run_with(
        None,
        &["--output", "human", "probe", "count", "--count", "2"],
        Some(OutputForm::Human),
    )
    .await
    .unwrap();
    assert_eq!(
        (unknown.code, unknown.stdout.as_str()),
        (exit::UNKNOWN_CAPABILITY, "")
    );
}

#[tokio::test]
async fn output_flags_are_anywhere_the_last_one_wins_and_an_output_flag_can_take_h() {
    let output = || {
        CliOutput::new()
            .default_form(OutputDefault::Json)
            .switch(["-h", "--human"], OutputForm::Human)
            .switch(["--json", "--no-human"], OutputForm::Json)
            .values(
                ["--format", "-f"],
                [("text", OutputForm::Human), ("json", OutputForm::Json)],
            )
    };
    let ran = async |args: &[&str]| {
        let ran = run_with(Some(output()), args, None).await.unwrap();
        (ran.code, ran.stdout, ran.stderr)
    };
    assert_eq!(
        ran(&["-h", "probe", "count", "--count", "2"]).await,
        (exit::VALUE, COUNT_TEXT.into(), String::new())
    );
    assert_eq!(
        ran(&["probe", "count", "--count", "2", "--human", "--json"]).await,
        (exit::VALUE, COUNT_JSON.into(), String::new())
    );
    assert_eq!(
        ran(&["probe", "count", "--format=text", "--count", "2"]).await,
        (exit::VALUE, COUNT_TEXT.into(), String::new())
    );
    assert_eq!(
        ran(&["probe", "count", "--count", "2", "-f"]).await,
        (
            exit::INVALID_INPUT,
            String::new(),
            "The option -f must be text or json.".into()
        )
    );
    let (code, help, _) = ran(&["--help"]).await;
    assert_eq!(code, exit::VALUE);
    assert!(help.contains("Usage: probe <command> [flags]"), "{help}");
}

#[tokio::test]
async fn the_default_form_is_json_human_or_auto_from_the_terminal() {
    let args = ["probe", "count", "--count", "2"];
    let stdout = async |default: OutputDefault, auto_form: Option<OutputForm>| {
        let output = CliOutput::new().default_form(default);
        run_with(Some(output), &args, auto_form)
            .await
            .unwrap()
            .stdout
    };
    assert_eq!(
        stdout(OutputDefault::Json, Some(OutputForm::Human)).await,
        COUNT_JSON
    );
    assert_eq!(
        stdout(OutputDefault::Human, Some(OutputForm::Json)).await,
        COUNT_TEXT
    );
    assert_eq!(
        stdout(OutputDefault::Auto, Some(OutputForm::Human)).await,
        COUNT_TEXT
    );
    assert_eq!(stdout(OutputDefault::Auto, None).await, COUNT_JSON);
}

#[tokio::test]
async fn the_command_line_stops_when_it_starts_if_an_output_flag_has_a_name_that_is_not_valid_or_taken()
 {
    let fails = async |names: &[&str]| {
        let output = CliOutput::new().switch(names.iter().copied(), OutputForm::Json);
        run_with(Some(output), &["list"], None).await.err()
    };
    let expected = [
        (
            &["--cursor"][..],
            "The output flag --cursor has the same name as the flag --cursor of watch.",
        ),
        (
            &["--jammed"],
            "The output flag --jammed has the same name as the flag alias --jammed.",
        ),
        (
            &["--count"],
            "The output flag --count has the same name as a flag of the capability probe.count.",
        ),
        (
            &["--json", "--json"],
            "The output flag --json has the same name as another output flag.",
        ),
        (
            &["format"],
            "The output flag format is not a valid name. Give --<word> or -<letter or digit>.",
        ),
        (
            &["-ab"],
            "The output flag -ab is not a valid name. Give --<word> or -<letter or digit>.",
        ),
        (
            &["--version"],
            "The output flag --version has the same name as the flag --version.",
        ),
    ];
    for (names, message) in expected {
        assert_eq!(fails(names).await, Some(message.to_owned()), "{names:?}");
    }
}
