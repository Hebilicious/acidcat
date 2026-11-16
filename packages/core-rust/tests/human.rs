use std::sync::{Arc, Mutex};

use acid_cat_core::cli::{CliFormats, CliIo, CliOptions, OutputForm, exit, run_cli};
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
        .capability(count())
        .capability(jam())
        .build()
        .unwrap_or_else(|problems| panic!("the application does not conform: {problems:?}"))
}

async fn run(formats: CliFormats, args: &[&str]) -> Result<(i32, String), String> {
    let written = Arc::new(Mutex::new(String::new()));
    let (stdout, stderr) = (written.clone(), written.clone());
    let mut io = CliIo {
        stdout: Box::new(move |text| stdout.lock().unwrap().push_str(text)),
        stderr: Box::new(move |text| stderr.lock().unwrap().push_str(text)),
        cancel: CancellationToken::new(),
    };
    let mut options = CliOptions::new("probe", "0.0.0").formats(formats);
    options.output = Some(OutputForm::Human);
    let args: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
    let code = run_cli(&probe(), Arc::new(()), &options, &args, &mut io).await?;
    let text = written.lock().unwrap().clone();
    Ok((code, text))
}

#[tokio::test]
async fn a_value_that_does_not_decode_and_a_format_that_panics_give_the_generic_layout() {
    let formats = || {
        CliFormats::new()
            .capability(&count(), |count: &Count, _| {
                format!("count {}", count.count)
            })
            .failure(&jam(), |_: &Jammed, _| panic!("the format fails"))
    };
    assert_eq!(
        run(formats(), &["probe", "count", "--count", "2"]).await,
        Ok((exit::VALUE, "n  2".into()))
    );
    assert_eq!(
        run(formats(), &["probe", "jam"]).await,
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
