use std::sync::{Arc, Mutex};

use acid_cat_core::cli::{CliAliases, CliFormats, CliOutput, CliUi, OutputDefault, OutputForm};
use acid_cat_core::{App, Application, Availability, Emitted, RunResult, Target, fail};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, watch};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
enum Mode {
    Cool,
    Heat,
    Dry,
    Fan,
    Auto,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
enum FanSpeed {
    Auto,
    Low,
    Medium,
    High,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
enum Day {
    Mon,
    Tue,
    Wed,
    Thu,
    Fri,
    Sat,
    Sun,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
struct Schedule {
    days: Vec<Day>,
    #[schemars(inner(range(min = 0, max = 23)))]
    hours: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Status {
    power: bool,
    mode: Mode,
    fan: FanSpeed,
    target_celsius: f64,
    room_celsius: f64,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(tag = "_tag")]
enum Offline {
    Offline {
        #[serde(skip_serializing_if = "Option::is_none")]
        since: Option<String>,
    },
}

#[derive(Serialize, JsonSchema)]
#[serde(tag = "_tag")]
enum ModeFailure {
    Offline {
        #[serde(skip_serializing_if = "Option::is_none")]
        since: Option<String>,
    },
    PoweredOff {},
}

#[derive(Serialize, JsonSchema)]
#[serde(tag = "_tag")]
#[expect(
    dead_code,
    reason = "The capability is unavailable while the unit is offline, so it never fails with Offline. The tag stays in the catalog, as in the Pkl source."
)]
enum FirmwareFailure {
    Offline {
        #[serde(skip_serializing_if = "Option::is_none")]
        since: Option<String>,
    },
    UpToDate {
        version: String,
    },
}

#[derive(Serialize, JsonSchema)]
#[serde(tag = "_tag")]
enum ExportFailure {
    Offline {
        #[serde(skip_serializing_if = "Option::is_none")]
        since: Option<String>,
    },
    WriteFailed {},
}

#[derive(Deserialize, JsonSchema)]
struct Export {
    path: String,
}

#[derive(Serialize, Deserialize, JsonSchema)]
struct Power {
    on: bool,
}

#[derive(Deserialize, JsonSchema)]
struct ModeInput {
    mode: Mode,
}

#[derive(Deserialize, JsonSchema)]
struct Temperature {
    #[schemars(range(min = 16, max = 31))]
    celsius: f64,
}

#[derive(Serialize, Deserialize, JsonSchema)]
struct Fan {
    speed: FanSpeed,
}

#[derive(Deserialize, JsonSchema)]
struct ScheduleInput {
    days: Vec<Day>,
    #[schemars(inner(range(min = 0, max = 23)))]
    hours: Option<Vec<u8>>,
}

#[derive(Deserialize, JsonSchema)]
#[schemars(transform = no_properties)]
struct NoInput {}

fn no_properties(schema: &mut schemars::Schema) {
    schema.insert("properties".into(), serde_json::json!({}));
}

pub struct Unit {
    status: watch::Sender<Status>,
    changes: broadcast::Sender<Status>,
    online: watch::Sender<Availability>,
    firmware: String,
    schedule: Mutex<Schedule>,
    files: bool,
}

impl Default for Unit {
    fn default() -> Self {
        Unit {
            status: watch::Sender::new(Status {
                power: false,
                mode: Mode::Cool,
                fan: FanSpeed::Auto,
                target_celsius: 22.0,
                room_celsius: 25.0,
            }),
            changes: broadcast::Sender::new(256),
            online: watch::Sender::new(Availability::Available),
            firmware: "1.0.0".into(),
            schedule: Mutex::new(Schedule {
                days: Vec::new(),
                hours: Vec::new(),
            }),
            files: false,
        }
    }
}

impl Unit {
    fn is_online(&self) -> bool {
        self.online.borrow().is_available()
    }

    fn change<F>(&self, update: impl FnOnce(&mut Status)) -> RunResult<(), F>
    where
        F: From<Offline>,
    {
        if !self.is_online() {
            return fail(F::from(Offline::Offline { since: None }));
        }
        let changed = self.status.send_if_modified(|status| {
            let before = status.clone();
            update(status);
            *status != before
        });
        if changed {
            let _ = self.changes.send(self.status.borrow().clone());
        }
        Ok(())
    }

    pub fn set_online(&self, online: bool) {
        self.online.send_replace(if online {
            Availability::Available
        } else {
            Availability::unavailable("The unit is offline.")
        });
    }
}

impl From<Offline> for ModeFailure {
    fn from(Offline::Offline { since }: Offline) -> Self {
        ModeFailure::Offline { since }
    }
}

type Capability = acid_cat_core::Capability<Unit>;
type Event = acid_cat_core::Event<Unit>;

const EVERYWHERE: [&str; 5] = ["app", "taskbar", "cli", "mcp", "api"];
const CONTROLS: [&str; 4] = ["app", "cli", "mcp", "api"];

fn target(description: &str, bindings: &[&str]) -> Target {
    Target {
        bindings: bindings
            .iter()
            .map(|binding| (*binding).to_owned())
            .collect(),
        description: Some(description.into()),
        options: None,
    }
}

fn word(value: impl Serialize) -> String {
    match serde_json::to_value(value) {
        Ok(serde_json::Value::String(word)) => word,
        _ => String::new(),
    }
}

fn status_text(status: &Status, ui: &CliUi) -> String {
    format!(
        "{} · {} · fan {} · target {}°C · room {}°C",
        ui.bold(if status.power { "on" } else { "off" }),
        word(status.mode),
        word(status.fan),
        status.target_celsius,
        status.room_celsius
    )
}

pub fn aircon() -> (Arc<Application<Unit>>, CliOutput) {
    let status_get = Capability::new(
        "aircon.status.get",
        "Read the unit's power, mode, fan speed, target temperature and room temperature.",
    )
    .audience(EVERYWHERE)
    .read_only()
    .output::<Status>()
    .failures::<Offline>()
    .state(|unit: &Unit| unit.status.subscribe())
    .run(|(), call| async move {
        let unit = call.context();
        if !unit.is_online() {
            return fail(Offline::Offline { since: None });
        }
        Ok(unit.status.borrow().clone())
    });
    let power_set = Capability::new("aircon.power.set", "Turn the unit on or off.")
        .audience(EVERYWHERE)
        .destructive(true)
        .idempotent(true)
        .input::<Power>()
        .failures::<Offline>()
        .run(|Power { on }, call| async move {
            call.context().change::<Offline>(|status| status.power = on)
        });
    let fan_set = Capability::new("aircon.fan.set", "Set the fan speed.")
        .audience(CONTROLS)
        .destructive(true)
        .idempotent(true)
        .input::<Fan>()
        .failures::<Offline>()
        .run(|Fan { speed }, call| async move {
            call.context()
                .change::<Offline>(|status| status.fan = speed)
        });
    let status_changed = Event::new("aircon.status.changed", "The status of the unit changed.")
        .audience(EVERYWHERE)
        .input::<NoInput>()
        .payload::<Status>()
        .subscribe(|_, subscription| {
            // The receiver is made when the subscription starts, so the subscription gets each change after it.
            let changes = subscription.context().changes.subscribe();
            futures::stream::unfold(changes, |mut changes| async move {
                let mut skipped = false;
                loop {
                    match changes.recv().await {
                        Ok(status) => {
                            let occurrence = Emitted::new(status);
                            let occurrence = if skipped {
                                occurrence.truncated()
                            } else {
                                occurrence
                            };
                            return Some((Ok(occurrence), changes));
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => skipped = true,
                        Err(broadcast::error::RecvError::Closed) => return None,
                    }
                }
            })
        });

    let output = CliOutput::new()
        .default_form(OutputDefault::Auto)
        .values(
            ["--output", "-o"],
            [("human", OutputForm::Human), ("json", OutputForm::Json)],
        )
        .switch(["--json"], OutputForm::Json);
    let formats = CliFormats::new()
        .capability(&status_get, status_text)
        .failure(&status_get, |Offline::Offline { since }: &Offline, ui| {
            let since = since
                .as_ref()
                .map(|since| format!(" since {since}"))
                .unwrap_or_default();
            format!("{}{since}", ui.error("offline"))
        })
        .event(&status_changed, status_text);

    let app = App::new()
        .title("Living-room air conditioner")
        .description("Control and monitor one split-unit air conditioner on the home network.")
        // WebMCP runs in a web page, so this program serves no WebMCP tools.
        .target_with(
            "app",
            target(
                "The phone, desktop and web apps that people use.",
                &["typescript", "webmcp", "acme:swift", "acme:kotlin"],
            ),
        )
        .target_with(
            "taskbar",
            target(
                "A desktop taskbar widget showing the status and a power toggle.",
                &["typescript"],
            ),
        )
        .target("cli", ["cli"])
        .cli_aliases(
            "cli",
            CliAliases::new()
                .alias_default("status", &status_get)
                .alias_with("--on", &power_set, Power { on: true })
                .alias_with("--off", &power_set, Power { on: false })
                .alias("aircon power", &power_set)
                .alias("follow", &status_changed)
                .alias("fan", &fan_set)
                .alias_with(
                    "fan auto",
                    &fan_set,
                    Fan {
                        speed: FanSpeed::Auto,
                    },
                )
                .alias_with(
                    "fan high",
                    &fan_set,
                    Fan {
                        speed: FanSpeed::High,
                    },
                ),
        )
        .target_with("mcp", target("Agents, through an MCP server.", &["mcp"]))
        .target_with(
            "api",
            target("Home-automation systems and scripts.", &["http"]),
        )
        .capability(status_get)
        .capability(power_set)
        .capability(
            Capability::new("aircon.mode.set", "Choose how the unit runs.")
                .audience(CONTROLS)
                .destructive(true)
                .idempotent(true)
                .input::<ModeInput>()
                .failures::<ModeFailure>()
                .run(|ModeInput { mode }, call| async move {
                    let unit = call.context();
                    if !unit.status.borrow().power {
                        return fail(ModeFailure::PoweredOff {});
                    }
                    unit.change::<ModeFailure>(|status| status.mode = mode)
                }),
        )
        .capability(
            Capability::new(
                "aircon.temperature.set",
                "Set the target temperature in degrees Celsius.",
            )
            .audience(CONTROLS)
            .destructive(true)
            .idempotent(true)
            .input::<Temperature>()
            .failures::<Offline>()
            .run(|Temperature { celsius }, call| async move {
                call.context()
                    .change::<Offline>(|status| status.target_celsius = celsius)
            }),
        )
        .capability(fan_set)
        .capability(
            Capability::new(
                "aircon.schedule.set",
                "Turn the unit on at each given hour, on each given day. The default hour is 7.",
            )
            .audience(CONTROLS)
            .destructive(true)
            .idempotent(true)
            .input::<ScheduleInput>()
            .output::<Schedule>()
            .failures::<Offline>()
            .run(|ScheduleInput { days, hours }, call| async move {
                let unit = call.context();
                if !unit.is_online() {
                    return fail(Offline::Offline { since: None });
                }
                let schedule = Schedule {
                    days,
                    hours: hours.unwrap_or_else(|| vec![7]),
                };
                *unit
                    .schedule
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = schedule.clone();
                Ok(schedule)
            }),
        )
        .capability(
            Capability::new(
                "aircon.status.export",
                "Write the status to a JSON file. A cancelled call can still write the file.",
            )
            .audience(["cli"])
            .input::<Export>()
            .failures::<ExportFailure>()
            .run(|Export { path }, call| async move {
                let unit = call.context();
                if !unit.is_online() {
                    return fail(ExportFailure::Offline { since: None });
                }
                let text = serde_json::to_string(&*unit.status.borrow()).unwrap_or_default();
                if !unit.files || std::fs::write(path, text).is_err() {
                    return fail(ExportFailure::WriteFailed {});
                }
                Ok(())
            }),
        )
        .capability(
            Capability::new(
                "aircon.firmware.update",
                "Install the latest firmware. The unit restarts and is offline for about a minute.",
            )
            .audience(["app"])
            .failures::<FirmwareFailure>()
            .availability(|unit: &Unit| unit.online.subscribe())
            .run(|(), call| async move {
                fail(FirmwareFailure::UpToDate {
                    version: call.context().firmware.clone(),
                })
            }),
        )
        .event(status_changed)
        .build()
        .unwrap_or_else(|problems| panic!("the air conditioner does not conform: {problems:?}"));
    (app, output.formats(formats))
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (app, output) = aircon();
    let unit = Arc::new(Unit::default());
    match args.first().map(String::as_str) {
        Some("catalog") => print!("{}", app.render_catalog()),
        Some("cli") => {
            use acid_cat_core::cli::{CliOptions, run_cli_process};
            use acid_cat_core::http::HttpClient;
            let unit = Arc::new(Unit {
                files: true,
                ..Unit::default()
            });
            let mut options = CliOptions::new("aircon", "0.1.0").output(output);
            if let Ok(url) = std::env::var("AIRCON_URL") {
                match HttpClient::new(&url) {
                    Ok(client) => options = options.remote(client),
                    Err(problem) => {
                        eprintln!("AIRCON_URL: {problem}");
                        std::process::exit(2);
                    }
                }
            }
            std::process::exit(run_cli_process(app, unit, options, args[1..].to_vec()).await);
        }
        Some("serve") => {
            use acid_cat_core::http::{HttpBinding, HttpOptions};
            let cli = HttpBinding::new(
                app,
                unit,
                HttpOptions {
                    target: "cli".into(),
                    base: "/cli".into(),
                    ..HttpOptions::default()
                },
            );
            let address = args.get(1).map_or("127.0.0.1:0", String::as_str);
            let served = acid_cat_core::remote::serve(
                address.parse().expect("an address such as 0.0.0.0:8080"),
                vec![("/cli".into(), Arc::new(cli))],
            )
            .await
            .expect("the server starts");
            println!("{}/cli", served.url());
            std::future::pending::<()>().await;
        }
        Some("mcp-stdio") => {
            use acid_cat_core::mcp::{McpStdioOptions, serve_stdio};
            serve_stdio(app, unit, McpStdioOptions::new("aircon", "0.1.0")).await;
        }
        _ => {
            eprintln!("Usage: aircon <catalog|cli|serve|mcp-stdio> [args]");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use acid_cat_core::{Outcome, Session, SubscribeOptions};
    use serde_json::json;
    use tokio_util::sync::CancellationToken;

    use super::*;

    #[tokio::test]
    async fn the_unit_works_through_a_session() {
        let unit = Arc::new(Unit::default());
        let session = Session::open(&aircon().0, "mcp", unit.clone());
        let cancel = CancellationToken::new();
        assert_eq!(
            session
                .invoke("aircon.mode.set", json!({ "mode": "heat" }), &cancel)
                .await,
            Outcome::Failure(json!({ "_tag": "PoweredOff" }))
        );
        assert_eq!(
            session
                .invoke("aircon.power.set", json!({ "on": true }), &cancel)
                .await,
            Outcome::Value(json!(null))
        );
        let Outcome::CallFailure(invalid) = session
            .invoke("aircon.temperature.set", json!({ "celsius": 40 }), &cancel)
            .await
        else {
            panic!("a temperature outside 16 to 31 is a call failure");
        };
        assert_eq!(invalid.kind, acid_cat_core::Kind::InvalidInput);
        unit.set_online(false);
        assert_eq!(
            session
                .invoke("aircon.fan.set", json!({ "speed": "high" }), &cancel)
                .await,
            Outcome::Failure(json!({ "_tag": "Offline" }))
        );
    }

    #[tokio::test]
    async fn aircon_status_changed_gives_the_new_status_after_each_change_and_nothing_for_the_same_status()
     {
        let unit = Arc::new(Unit::default());
        let session = Session::open(&aircon().0, "app", unit.clone());
        let cancel = CancellationToken::new();
        let mut occurrences = session
            .subscribe(
                "aircon.status.changed",
                json!({}),
                SubscribeOptions::default(),
            )
            .expect("the subscription starts");
        session
            .invoke("aircon.power.set", json!({ "on": true }), &cancel)
            .await;
        session
            .invoke("aircon.power.set", json!({ "on": true }), &cancel)
            .await;
        session
            .invoke("aircon.fan.set", json!({ "speed": "high" }), &cancel)
            .await;
        let power = occurrences
            .next()
            .await
            .expect("an occurrence")
            .expect("no call failure");
        assert_eq!(power.name, "aircon.status.changed");
        assert_eq!(
            power.data,
            json!({ "power": true, "mode": "cool", "fan": "auto", "targetCelsius": 22.0, "roomCelsius": 25.0 })
        );
        let fan = occurrences
            .next()
            .await
            .expect("an occurrence")
            .expect("no call failure");
        assert_eq!(fan.data["fan"], json!("high"));
        assert_eq!(fan.data["power"], json!(true));
        assert_eq!(unit.changes.receiver_count(), 1);
        drop(occurrences);
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while unit.changes.receiver_count() > 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the subscription stops listening when it ends");
    }

    #[tokio::test]
    async fn the_state_of_aircon_status_get_gives_copies_and_each_change() {
        let unit = Arc::new(Unit::default());
        let session = Session::open(&aircon().0, "app", unit.clone());
        let mut state = session
            .state("aircon.status.get")
            .expect("aircon.status.get has state");
        assert_eq!(state.snapshot()["power"], json!(false));
        session
            .invoke(
                "aircon.power.set",
                json!({ "on": true }),
                &CancellationToken::new(),
            )
            .await;
        assert!(state.changed().await);
        assert_eq!(state.snapshot()["power"], json!(true));
        assert!(session.state("aircon.power.set").is_none());
    }

    fn human_text(name: &str) -> String {
        let declaration = format!("export const {name} = \"");
        include_str!("../../test/human.ts")
            .lines()
            .find_map(|line| line.strip_prefix(&declaration)?.strip_suffix("\";"))
            .unwrap_or_else(|| panic!("test/human.ts has the string {name}"))
            .to_owned()
    }

    async fn on_terminal(unit: Arc<Unit>, args: &[&str]) -> (i32, String) {
        use acid_cat_core::cli::{CliIo, CliOptions, run_cli};

        let (app, output) = aircon();
        let written = Arc::new(Mutex::new(String::new()));
        let stdout = written.clone();
        let mut io = CliIo {
            stdout: Box::new(move |text| stdout.lock().unwrap().push_str(text)),
            stderr: Box::new(|text| panic!("no text on standard error: {text}")),
            cancel: CancellationToken::new(),
            form: OutputForm::Json,
        };
        let args: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
        let mut options = CliOptions::new("aircon", "0.1.0").output(output);
        options.auto_form = Some(OutputForm::Human);
        let code = run_cli(&app, unit, &options, &args, &mut io)
            .await
            .expect("the command line starts");
        let text = written.lock().unwrap().clone();
        (code, text)
    }

    #[tokio::test]
    async fn on_a_terminal_the_command_line_writes_the_human_form_unless_an_output_flag_chooses_json()
     {
        let unit = || Arc::new(Unit::default());
        assert_eq!(
            on_terminal(unit(), &["status"]).await,
            (0, human_text("STATUS_OFF"))
        );
        let (code, json) = on_terminal(unit(), &["status", "--json"]).await;
        assert_eq!(code, 0);
        let status: serde_json::Value = serde_json::from_str(&json).expect("the output is JSON");
        assert_eq!(status["power"], serde_json::json!(false));
        assert_eq!(on_terminal(unit(), &["--json"]).await, (0, json));
        let offline = unit();
        offline.set_online(false);
        assert_eq!(
            on_terminal(offline, &["aircon", "status", "get"]).await,
            (1, human_text("OFFLINE"))
        );
    }

    #[tokio::test]
    async fn aircon_firmware_update_is_unavailable_while_the_unit_is_offline() {
        let unit = Arc::new(Unit::default());
        let session = Session::open(&aircon().0, "app", unit.clone());
        let cancel = CancellationToken::new();
        assert_eq!(
            session
                .invoke("aircon.firmware.update", json!({}), &cancel)
                .await,
            Outcome::Failure(json!({ "_tag": "UpToDate", "version": "1.0.0" }))
        );
        unit.set_online(false);
        let Outcome::CallFailure(failure) = session
            .invoke("aircon.firmware.update", json!({}), &cancel)
            .await
        else {
            panic!("a call failure")
        };
        assert_eq!(failure.kind, acid_cat_core::Kind::Unavailable);
    }
}
