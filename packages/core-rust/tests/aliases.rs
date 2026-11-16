use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use acid_cat_core::cli::{CliCommand, CliIo, CliOptions, exit, run_cli};
use acid_cat_core::{App, Application, CapabilityDefinition, Emitted, EventDefinition, Target};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

type Capability = acid_cat_core::Capability<()>;
type Event = acid_cat_core::Event<()>;

/// Cargo builds the examples before the integration tests, beside the directory of the tests.
fn fixture() -> PathBuf {
    let tests = std::env::current_exe().expect("the path of the test program");
    let target = tests
        .parent()
        .and_then(Path::parent)
        .expect("the target directory");
    target.join("examples").join(if cfg!(windows) {
        "fixture.exe"
    } else {
        "fixture"
    })
}

fn fixture_cli(args: &[&str]) -> (i32, String) {
    let output = Command::new(fixture())
        .arg("cli")
        .args(args)
        .output()
        .expect("the fixture runs");
    let stdout = String::from_utf8(output.stdout).expect("the output is UTF-8");
    (output.status.code().unwrap_or(-1), stdout)
}

fn parsed(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_else(|_| panic!("the output is JSON: {text}"))
}

fn probe(aliases: Value, capabilities: Vec<CapabilityDefinition<()>>) -> Arc<Application<()>> {
    probe_with(json!({ "aliases": aliases }), capabilities, Vec::new())
}

fn probe_with(
    settings: Value,
    capabilities: Vec<CapabilityDefinition<()>>,
    events: Vec<EventDefinition<()>>,
) -> Arc<Application<()>> {
    let mut app = App::new().title("Probe").target_with(
        "cli",
        Target {
            bindings: vec!["cli".into()],
            options: Some(json!({ "cli": settings })),
            ..Target::default()
        },
    );
    for capability in capabilities {
        app = app.capability(capability);
    }
    for event in events {
        app = app.event(event);
    }
    app.build()
        .unwrap_or_else(|problems| panic!("the application does not conform: {problems:?}"))
}

fn ping() -> CapabilityDefinition<()> {
    Capability::new("probe.ping", "Ping.")
        .audience(["cli"])
        .run(|(), _| async move { Ok(()) })
}

async fn run(
    app: &Arc<Application<()>>,
    options: CliOptions<()>,
    args: &[&str],
) -> Result<(i32, String), String> {
    let written = Arc::new(Mutex::new(String::new()));
    let (stdout, stderr) = (written.clone(), written.clone());
    let mut io = CliIo {
        stdout: Box::new(move |text| stdout.lock().unwrap().push_str(text)),
        stderr: Box::new(move |text| stderr.lock().unwrap().push_str(text)),
        cancel: CancellationToken::new(),
    };
    let args: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
    let code = run_cli(app, Arc::new(()), &options, &args, &mut io).await?;
    let text = written.lock().unwrap().clone();
    Ok((code, text))
}

#[test]
fn the_help_lists_the_aliases_and_an_alias_with_help_gives_its_usage() {
    let (_, help) = fixture_cli(&["--help"]);
    assert!(
        help.ends_with(
            "\nAliases:\n  --hello\n  broken-ticks [--cursor <string>] [--max-age-ms <integer>]\n  echoes '<json>' [--cursor <string>] [--max-age-ms <integer>]\n  fixed-note [--loud]\n  held-keys\n  quick [--count <integer>] [--extra <json>] [--label <string>] [--ratio <number>] [--steps <integer>...] [--tags <string>...] [--verbose]\n  raw '<json>'\n  say --text <string>\n  ticks [--gap <integer>] [--key <string>] [--cursor <string>] [--max-age-ms <integer>]\n"
        ),
        "{help}"
    );
    assert_eq!(
        fixture_cli(&["say", "--help"]).1,
        "Usage: fixture say --text <string>\n\nReturn the input text.\n"
    );
}

#[derive(Serialize, Deserialize, JsonSchema)]
struct Power {
    on: bool,
}

#[tokio::test]
async fn the_command_line_stops_when_it_starts_if_an_alias_breaks_a_rule() {
    let power = || {
        Capability::new("probe.power.set", "Turn the probe on or off.")
            .audience(["cli"])
            .input::<Power>()
            .run(|_: Power, _| async move { Ok(()) })
    };
    let start = |aliases: Value| async move {
        run(
            &probe(aliases, vec![ping(), power()]),
            CliOptions::new("probe", "0.0.0"),
            &["list"],
        )
        .await
    };
    for (aliases, message) in [
        (
            json!({ "list": { "capability": "probe.ping" } }),
            "target cli: the alias list has the name of a command or a flag of the command line",
        ),
        (
            json!({ "--help": { "capability": "probe.ping" } }),
            "target cli: the alias --help has the name of a command or a flag of the command line",
        ),
        (
            json!({ "--version": { "capability": "probe.ping" } }),
            "target cli: the alias --version has the name of a command or a flag of the command line",
        ),
        (
            json!({ "probe": { "capability": "probe.ping" } }),
            "target cli: the alias probe has the name of the first word of the command of a capability",
        ),
        (
            json!({ "gone": { "capability": "probe.gone" } }),
            "target cli: the alias gone refers to probe.gone, which is not a capability in the view of the target",
        ),
        (
            json!({ "Bad": { "capability": "probe.ping" } }),
            "target cli: the alias Bad must be one word, or -- and one word, with the letters a-z, the digits 0-9 and single hyphens",
        ),
        (
            json!({ "odd": { "capability": "probe.ping", "extra": 1 } }),
            "target cli: the alias odd has the unknown member extra",
        ),
        (
            json!({ "loud": { "capability": "probe.ping", "input": { "volume": 1 } } }),
            "target cli: the alias loud has a fixed input, but the input schema of probe.ping has no properties",
        ),
        (
            json!({ "--on": { "capability": "probe.power.set", "input": { "volume": 1 } } }),
            "target cli: the alias --on has the fixed input volume, which is not a property of the input of probe.power.set",
        ),
    ] {
        assert_eq!(start(aliases).await, Err(message.to_owned()));
    }
    let (code, text) = start(json!({ "ping": { "capability": "probe.ping", "x-note": "Ping." } }))
        .await
        .expect("the aliases follow the rules");
    assert_eq!(code, exit::VALUE, "{text}");
}

#[test]
fn the_input_schema_of_fixture_note_is_a_ref_with_a_description_beside_it() {
    let catalog = Command::new(fixture())
        .arg("catalog")
        .output()
        .expect("the fixture runs");
    let catalog = parsed(&String::from_utf8(catalog.stdout).expect("the output is UTF-8"));
    let input = &catalog["capabilities"]["fixture.note"]["input"];
    assert_eq!(input["$ref"], json!("#/$defs/Note"));
    assert_eq!(input["description"], json!("The note."));
}

#[tokio::test]
async fn a_command_of_the_application_must_not_have_the_name_of_an_alias() {
    let app = probe(
        json!({ "say": { "capability": "probe.ping" } }),
        vec![ping()],
    );
    let mut options = CliOptions::new("probe", "0.0.0");
    options.commands.push(CliCommand {
        name: "say".into(),
        description: "A command.".into(),
        run: Arc::new(|_, _, _| Box::pin(async { 0 })),
    });
    assert_eq!(
        run(&app, options, &["list"]).await,
        Err("The command say of the application has the same name as another command.".into())
    );
}

#[derive(Serialize, Deserialize, JsonSchema)]
struct Reading {
    room: String,
}

fn readings() -> EventDefinition<()> {
    Event::new("probe.readings", "Give one reading of the room.")
        .audience(["cli"])
        .input::<Reading>()
        .payload::<Reading>()
        .subscribe(|reading: Reading, _| futures::stream::iter([Ok(Emitted::new(reading))]))
}

#[derive(Serialize, Deserialize, JsonSchema)]
struct Helpful {
    help: Option<bool>,
}

#[tokio::test]
async fn the_command_line_stops_when_it_starts_if_an_alias_of_an_event_or_the_default_alias_breaks_a_rule()
 {
    let helpful = || {
        Capability::new("probe.helpful", "Help.")
            .audience(["cli"])
            .input::<Helpful>()
            .run(|_: Helpful, _| async move { Ok(()) })
    };
    let start = |settings: Value| async move {
        run(
            &probe_with(settings, vec![ping(), helpful()], vec![readings()]),
            CliOptions::new("probe", "0.0.0"),
            &["list"],
        )
        .await
    };
    for (settings, message) in [
        (
            json!({ "aliases": { "both": { "capability": "probe.ping", "event": "probe.readings" } } }),
            "target cli: the alias both must be an object with the id of a capability in capability, or the id of an event in event",
        ),
        (
            json!({ "aliases": { "neither": { "input": {} } } }),
            "target cli: the alias neither must be an object with the id of a capability in capability, or the id of an event in event",
        ),
        (
            json!({ "aliases": { "gone": { "event": "probe.gone" } } }),
            "target cli: the alias gone refers to probe.gone, which is not an event in the view of the target",
        ),
        (
            json!({ "aliases": { "pinged": { "event": "probe.ping" } } }),
            "target cli: the alias pinged refers to probe.ping, which is not an event in the view of the target",
        ),
        (
            json!({ "aliases": { "hall": { "event": "probe.readings", "input": { "floor": 1 } } } }),
            "target cli: the alias hall has the fixed input floor, which is not a property of the input of probe.readings",
        ),
        (
            json!({ "aliases": { "hall": { "event": "probe.readings", "extra": 1 } } }),
            "target cli: the alias hall has the unknown member extra",
        ),
        (
            json!({ "aliases": { "--ping": { "capability": "probe.ping" } }, "default": "--ping" }),
            "target cli: options.cli.default must be the name of a command alias",
        ),
        (
            json!({ "default": "ping" }),
            "target cli: options.cli.default must be the name of a command alias",
        ),
        (
            json!({ "aliases": { "ping": { "capability": "probe.ping" } }, "default": 1 }),
            "target cli: options.cli.default must be the name of a command alias",
        ),
        (
            json!({ "aliases": { "gone": { "capability": "probe.gone" } }, "default": "gone" }),
            "target cli: the alias gone refers to probe.gone, which is not a capability in the view of the target",
        ),
        (
            json!({ "aliases": { "aid": { "capability": "probe.helpful" } }, "default": "aid" }),
            "target cli: the default alias aid has the flag --help, which is a flag of the command line",
        ),
        (
            json!({ "aliases": {
                "follow": { "event": "probe.readings" },
                "--cursor": { "capability": "probe.ping" },
                "--room": { "capability": "probe.ping" }
            }, "default": "follow" }),
            "target cli: the alias --cursor has the name of a flag of the default alias follow\ntarget cli: the alias --room has the name of a flag of the default alias follow",
        ),
    ] {
        assert_eq!(start(settings).await, Err(message.to_owned()));
    }
    let (code, text) = start(json!({
        "aliases": { "hall": { "event": "probe.readings", "input": { "room": "hall" }, "x-note": "The hall." } },
        "default": "hall"
    }))
    .await
    .expect("the aliases follow the rules");
    assert_eq!(code, exit::VALUE, "{text}");
}
