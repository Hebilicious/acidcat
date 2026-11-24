#[path = "../tests/fixture_settings/mod.rs"]
mod fixture_settings;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use acid_cat_core::{App, Application, Availability, Defect, Emitted, Target, fail};

type Capability = acid_cat_core::Capability<Fixture>;
type Event = acid_cat_core::Event<Fixture>;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::sync::{Notify, mpsc, watch};
use tokio_util::sync::CancellationToken;

pub struct Fixture {
    switch: watch::Sender<Availability>,
    holds: Holds,
    watchers: Watchers,
}

impl Default for Fixture {
    fn default() -> Self {
        Fixture {
            switch: watch::Sender::new(Availability::Available),
            holds: Holds::default(),
            watchers: Watchers::default(),
        }
    }
}

#[derive(Default)]
struct Holds {
    next: AtomicU64,
    holding: Mutex<HashMap<u64, (String, Arc<Notify>)>>,
    blocks_its_thread: bool,
    holds_interrupt_until_go: bool,
}

impl Holds {
    async fn hold(&self, key: String, marker: Option<String>, cancel: CancellationToken) {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let released = Arc::new(Notify::new());
        self.holding
            .lock()
            .unwrap()
            .insert(id, (key, released.clone()));
        let _forget = Forget(|| {
            self.holding.lock().unwrap().remove(&id);
        });
        let _cancelled = match &marker {
            Some(path) if self.blocks_its_thread => Some(write_cancel_marker_then_hold_interrupt(
                &cancel,
                path,
                self.holds_interrupt_until_go,
            )),
            _ => None,
        };
        let _marker = marker.map(MarkerFileWhileAlive::write);
        if self.blocks_its_thread {
            loop {
                std::thread::park();
            }
        }
        released.notified().await;
    }

    fn held(&self) -> Vec<String> {
        let holding = self.holding.lock().unwrap();
        let mut entries: Vec<_> = holding.iter().collect();
        entries.sort_by_key(|(id, _)| **id);
        entries
            .into_iter()
            .map(|(_, (key, _))| key.clone())
            .collect()
    }

    fn release(&self, key: &str) {
        for (held, released) in self.holding.lock().unwrap().values() {
            if held == key {
                released.notify_one();
            }
        }
    }
}

#[derive(Default)]
struct Watchers {
    next: AtomicU64,
    watching: Mutex<HashMap<u64, (String, mpsc::UnboundedSender<String>)>>,
}

impl Watchers {
    fn watching(&self) -> Vec<String> {
        let watching = self.watching.lock().unwrap();
        let mut entries: Vec<_> = watching.iter().collect();
        entries.sort_by_key(|(id, _)| **id);
        entries
            .into_iter()
            .map(|(_, (key, _))| key.clone())
            .collect()
    }

    fn signal(&self, key: &str, value: &str) -> usize {
        self.watching
            .lock()
            .unwrap()
            .values()
            .filter(|(watched, sender)| watched == key && sender.send(value.to_owned()).is_ok())
            .count()
    }
}

struct Forget<F: FnMut()>(F);

struct CancelMarkerThenHoldInterrupt {
    marker: String,
    holds_until_go: bool,
}

// tokio_util wakes this waker inside the `cancel` of the token, so it holds that `cancel` while it waits.
impl std::task::Wake for CancelMarkerThenHoldInterrupt {
    fn wake(self: Arc<Self>) {
        let _ = std::fs::write(format!("{}.cancelled", self.marker), "");
        let go = std::path::PathBuf::from(format!("{}.go", self.marker));
        // The hold ends when the test process ends, so a test that stops early leaves no process behind.
        let test = parent_process();
        while self.holds_until_go && !go.exists() && parent_process() == test {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }
}

fn write_cancel_marker_then_hold_interrupt(
    cancel: &CancellationToken,
    marker: &str,
    holds_until_go: bool,
) -> std::pin::Pin<Box<tokio_util::sync::WaitForCancellationFutureOwned>> {
    let mut cancelled = Box::pin(cancel.clone().cancelled_owned());
    let waker = std::task::Waker::from(Arc::new(CancelMarkerThenHoldInterrupt {
        marker: marker.to_owned(),
        holds_until_go,
    }));
    if cancelled
        .as_mut()
        .poll(&mut std::task::Context::from_waker(&waker))
        .is_ready()
    {
        waker.wake();
    }
    cancelled
}

#[cfg(unix)]
fn parent_process() -> u32 {
    std::os::unix::process::parent_id()
}

#[cfg(not(unix))]
fn parent_process() -> u32 {
    0
}

struct MarkerFileWhileAlive(String);

impl MarkerFileWhileAlive {
    fn write(path: String) -> MarkerFileWhileAlive {
        let _ = std::fs::write(&path, "");
        MarkerFileWhileAlive(path)
    }
}

impl Drop for MarkerFileWhileAlive {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

impl<F: FnMut()> Drop for Forget<F> {
    fn drop(&mut self) {
        (self.0)();
    }
}

#[derive(Serialize, Deserialize, JsonSchema)]
struct Text {
    text: String,
}

#[derive(Serialize, Deserialize, JsonSchema)]
struct Key {
    key: String,
}

#[derive(Deserialize, JsonSchema)]
struct Hold {
    key: String,
    marker: Option<String>,
}

#[derive(Serialize, JsonSchema)]
struct Keys {
    keys: Vec<String>,
}

#[derive(Serialize, JsonSchema)]
struct Tick {
    n: i64,
}

#[derive(Serialize, Deserialize, JsonSchema)]
struct Watched {
    key: String,
    value: String,
}

#[derive(Deserialize, JsonSchema)]
struct Switch {
    #[schemars(extend("x-mcp-header" = "On"))]
    on: bool,
}

#[derive(Deserialize, JsonSchema)]
#[schemars(transform = with_no_properties)]
struct Nothing {}

fn with_no_properties(schema: &mut schemars::Schema) {
    schema.insert("properties".into(), Value::Object(Map::new()));
}

#[derive(Serialize, JsonSchema)]
struct Delivered {
    delivered: usize,
}

#[derive(Serialize, JsonSchema)]
#[serde(tag = "_tag")]
enum Refusal {
    Refused { reason: String },
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
enum Mode {
    Fast,
    Slow,
}

#[derive(Serialize, Deserialize, JsonSchema)]
struct Flags {
    mode: Mode,
    #[serde(skip_serializing_if = "Option::is_none")]
    count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ratio: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    verbose: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    extra: Option<Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    steps: Option<Vec<i64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tags: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize, JsonSchema)]
struct Note {
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    loud: Option<bool>,
}

/// The input of fixture.note. schemars writes a transparent newtype as the `$ref` of the type that it wraps, with the
/// description beside it.
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
#[schemars(description = "The note.")]
struct NoteInput(Note);

#[derive(Deserialize, JsonSchema)]
struct Ticks {
    #[schemars(range(min = 0, max = 100))]
    count: i64,
    #[schemars(range(min = 1, max = 100))]
    gap: Option<i64>,
    #[allow(dead_code)]
    #[schemars(extend("x-mcp-header" = "Key"))]
    key: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct Watch {
    key: String,
    marker: Option<String>,
}

const EVERYWHERE: [&str; 4] = ["app", "mcp", "cli", "api"];

pub fn fixture() -> Arc<Application<Fixture>> {
    App::new()
        .title("Fixture")
        .description("One capability or event for each behavior that acid-cat conform tests.")
        .target("app", ["typescript", "webmcp"])
        .target("mcp", ["mcp"])
        .target_with(
            "cli",
            Target {
                surfaces: vec!["cli".into()],
                options: Some(json!({
                    "cli": {
                        "aliases": {
                            "say": { "capability": "fixture.echo" },
                            "raw": { "capability": "fixture.raw" },
                            "held-keys": { "capability": "fixture.held" },
                            "--hello": { "capability": "fixture.echo", "input": { "text": "hello" } },
                            "quick": { "capability": "fixture.flags", "input": { "mode": "fast" } },
                            "fixture": { "capability": "fixture.flags", "input": { "mode": "slow" } },
                            "fixed-note": { "capability": "fixture.note", "input": { "text": "fixed" } },
                            "ticks": { "event": "fixture.ticks", "input": { "count": 2 } },
                            "broken-ticks": { "event": "fixture.broken" },
                            "echoes": { "event": "fixture.echoes" },
                            "notes": { "capability": "fixture.raw" },
                            "notes add": { "capability": "fixture.note" },
                            "notes loud": { "capability": "fixture.note", "input": { "loud": true } },
                            "shout hello": { "capability": "fixture.echo", "input": { "text": "HELLO" } }
                        },
                        "default": "quick"
                    }
                })),
                ..Target::default()
            },
        )
        .target("api", ["http"])
        .on_defect(|_, _| {})
        .capability(
            Capability::new("fixture.echo", "Return the input text.")
                .audience(EVERYWHERE)
                .read_only()
                .input::<Text>()
                .output::<Text>()
                .run(|input, _| async move { Ok(input) }),
        )
        .capability(
            Capability::new("fixture.refuse", "Always return the failure Refused.")
                .audience(EVERYWHERE)
                .failures::<Refusal>()
                .run(|(), _| async move { fail(Refusal::Refused { reason: "No.".into() }) }),
        )
        .capability(
            Capability::new("fixture.crash", "Always fail with a defect.")
                .audience(EVERYWHERE)
                .run(|(), _| async move { Err(Defect::new("secret internal detail").into()) }),
        )
        .capability(
            Capability::new(
                "fixture.hold",
                "Hold until fixture.release releases the key, then return the key. While the call holds, fixture.held gives the key. With a marker, the call writes a file at that path when it starts to hold, and deletes the file when it ends.",
            )
            .audience(EVERYWHERE)
            .input::<Hold>()
            .output::<Key>()
            .run(|Hold { key, marker }, call| async move {
                call.context()
                    .holds
                    .hold(key.clone(), marker, call.cancel_token().clone())
                    .await;
                Ok(Key { key })
            }),
        )
        .capability(
            Capability::new("fixture.held", "Return the keys of the calls to fixture.hold that hold now.")
                .audience(EVERYWHERE)
                .read_only()
                .output::<Keys>()
                .run(|(), call| async move { Ok(Keys { keys: call.context().holds.held() }) }),
        )
        .capability(
            Capability::new("fixture.note", "Return the input. The input schema is a $ref with a description beside it.")
                .audience(["cli"])
                .input::<NoteInput>()
                .output::<Note>()
                .run(|NoteInput(note), _| async move { Ok(note) }),
        )
        .capability(
            Capability::new("fixture.raw", "Return the input. The input schema has no top-level properties member.")
                .audience(["cli"])
                .input_schema::<Map<String, Value>>(json!({ "type": "object" }))
                .output_schema::<Map<String, Value>>(json!({ "type": "object" }))
                .run(|input, _| async move { Ok(input) }),
        )
        .capability(
            Capability::new("fixture.release", "Release the calls to fixture.hold that hold the key.")
                .audience(EVERYWHERE)
                .input::<Key>()
                .run(|Key { key }, call| async move {
                    call.context().holds.release(&key);
                    Ok(())
                }),
        )
        .capability(
            Capability::new("fixture.hidden", "Only the app target can use this capability.")
                .audience(["app"])
                .run(|(), _| async move { Ok(()) }),
        )
        .capability(
            Capability::new("fixture.toggle", "Available only while the switch is on.")
                .audience(EVERYWHERE)
                .input::<Nothing>()
                .availability(|context: &Fixture| context.switch.subscribe())
                .run(|_, _| async move { Ok(()) }),
        )
        .capability(
            Capability::new("fixture.switch.set", "Turn the switch on or off. The switch controls the availability of fixture.toggle.")
                .audience(EVERYWHERE)
                .destructive(true)
                .idempotent(true)
                .input::<Switch>()
                .run(|Switch { on }, call| async move {
                    call.context().switch.send_replace(if on { Availability::Available } else { Availability::unavailable("The switch is off.") });
                    Ok(())
                }),
        )
        .capability(
            Capability::new("fixture.flags", "Return the input. The input has one property for each kind of command-line flag.")
                .audience(["cli"])
                .input::<Flags>()
                .output::<Flags>()
                .run(|input, _| async move { Ok(input) }),
        )
        .capability(
            Capability::new(
                "fixture.signal",
                "Give an occurrence of fixture.watch to each subscription that watches the key. Return the number of these subscriptions.",
            )
            .audience(EVERYWHERE)
            .destructive(false)
            .idempotent(false)
            .input::<Watched>()
            .output::<Delivered>()
            .run(|Watched { key, value }, call| async move { Ok(Delivered { delivered: call.context().watchers.signal(&key, &value) }) }),
        )
        .capability(
            Capability::new("fixture.watching", "Return the keys of the subscriptions to fixture.watch that are active now.")
                .audience(EVERYWHERE)
                .read_only()
                .output::<Keys>()
                .run(|(), call| async move { Ok(Keys { keys: call.context().watchers.watching() }) }),
        )
        .event(
            Event::new(
                "fixture.ticks",
                "Give the occurrences n = 1 to count, with the eventId and the cursor String(n), then end. With a cursor c, start at c + 1. With a gap g, the occurrence n = g has truncated: true, as if the source skipped occurrences before it. The key changes nothing: it gives the subscriptions of each test their own input.",
            )
            .audience(EVERYWHERE)
            .input::<Ticks>()
            .payload::<Tick>()
            .subscribe(|Ticks { count, gap, .. }, subscription| {
                let first = subscription.cursor().and_then(|cursor| cursor.parse::<i64>().ok()).filter(|position| *position >= 0).map_or(1, |position| position + 1);
                futures::stream::iter((first..=count).map(move |n| {
                    let tick = Emitted::new(Tick { n }).event_id(n.to_string()).cursor(n.to_string());
                    Ok(if Some(n) == gap { tick.truncated() } else { tick })
                }))
            }),
        )
        .event(
            Event::new(
                "fixture.watch",
                "Give an occurrence each time that fixture.signal gets the key. Never end. With a marker, write a file at that path when the subscription starts, and delete the file when it ends.",
            )
            .audience(EVERYWHERE)
            .input::<Watch>()
            .payload::<Watched>()
            .subscribe(|Watch { key, marker }, subscription| {
                let context = subscription.context_arc();
                async_stream::stream! {
                    let (sender, mut values) = mpsc::unbounded_channel();
                    let id = context.watchers.next.fetch_add(1, Ordering::Relaxed);
                    context.watchers.watching.lock().unwrap().insert(id, (key.clone(), sender));
                    let _forget = Forget(|| { context.watchers.watching.lock().unwrap().remove(&id); });
                    let _marker = marker.map(MarkerFileWhileAlive::write);
                    while let Some(value) = values.recv().await {
                        yield Ok(Emitted::new(Watched { key: key.clone(), value }));
                    }
                }
            }),
        )
        .event(
            Event::new("fixture.broken", "Give the occurrence n = 1, then fail with a defect.")
                .audience(EVERYWHERE)
                .payload::<Tick>()
                .subscribe(|(), _| futures::stream::iter([Ok(Emitted::new(Tick { n: 1 })), Err(Defect::new("secret internal detail"))])),
        )
        .event(
            Event::new("fixture.echoes", "Give one occurrence whose data is the input, then end.")
                .audience(["cli"])
                .input_schema::<Map<String, Value>>(json!({ "type": "object" }))
                .payload_schema::<Map<String, Value>>(json!({ "type": "object" }))
                .subscribe(|input, _| futures::stream::iter([Ok(Emitted::new(input))])),
        )
        .event(
            Event::new("fixture.secret", "Only the app target can follow this event. It never gives an occurrence.")
                .audience(["app"])
                .subscribe(|(), _| futures::stream::pending()),
        )
        .build()
        .unwrap_or_else(|problems| panic!("the fixture does not conform: {problems:?}"))
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let app = fixture();
    let context = Arc::new(Fixture::default());
    match args.first().map(String::as_str) {
        Some("catalog") => print!("{}", app.render_catalog()),
        Some("serve") => {
            use acid_cat_core::http::{HttpOptions, HttpSurface};
            use acid_cat_core::mcp::{McpOptions, McpSurface, Principal, WebhookOptions};
            let http = HttpSurface::new(
                app.clone(),
                context.clone(),
                HttpOptions {
                    base: "/api".into(),
                    ..HttpOptions::default()
                },
            );
            let webhooks = args
                .iter()
                .position(|arg| arg == "--webhook-ca")
                .and_then(|index| args.get(index + 1))
                .map(|file| WebhookOptions {
                    allow_private_networks: true,
                    trusted_certificates: vec![
                        std::fs::read_to_string(file).expect("the certificate file can be read"),
                    ],
                    retry_delay: Arc::new(|_| std::time::Duration::from_millis(50)),
                    min_ttl: std::time::Duration::from_millis(fixture_settings::WEBHOOK_MIN_TTL_MS),
                    max_subscriptions: fixture_settings::WEBHOOK_MAX_SUBSCRIPTIONS,
                    signing_keys: vec![signing_key("fixture-1"), signing_key("fixture-2")],
                    egress_ip_ranges: vec!["203.0.113.0/24".into(), "2001:db8::/32".into()],
                    ..WebhookOptions::default()
                });
            let principal: Principal = Arc::new(|headers| {
                headers
                    .get("authorization")?
                    .to_str()
                    .ok()?
                    .strip_prefix("Bearer ")
                    .map(str::to_owned)
            });
            let mcp = McpSurface::new(
                app.clone(),
                context.clone(),
                McpOptions {
                    poll: poll(),
                    principal: Some(principal),
                    webhooks,
                    ..McpOptions::new("fixture", "0.0.0")
                },
            );
            let mcp_lease = McpSurface::new(
                app.clone(),
                Arc::new(Fixture::default()),
                McpOptions {
                    poll: acid_cat_core::mcp::PollOptions {
                        lease: std::time::Duration::from_millis(fixture_settings::POLL_LEASE_MS),
                        ..Default::default()
                    },
                    ..McpOptions::new("fixture", "0.0.0")
                },
            );
            let cli = HttpSurface::new(
                app.clone(),
                context.clone(),
                HttpOptions {
                    target: "cli".into(),
                    base: "/cli".into(),
                    ..HttpOptions::default()
                },
            );
            let routes: acid_cat_core::remote::Routes = vec![
                ("/api".into(), Arc::new(http)),
                ("/cli".into(), Arc::new(cli)),
                ("/mcp".into(), Arc::new(mcp)),
                ("/mcp-lease".into(), Arc::new(mcp_lease)),
            ];
            let served = acid_cat_core::remote::serve("127.0.0.1:0".parse().unwrap(), routes)
                .await
                .expect("the server starts");
            println!("{}", served.url());
            std::future::pending::<()>().await;
        }
        Some("mcp-stdio") => {
            use acid_cat_core::mcp::{McpStdioOptions, serve_stdio};
            serve_stdio(
                app,
                context,
                McpStdioOptions {
                    poll: poll(),
                    ..McpStdioOptions::new("fixture", "0.0.0")
                },
            )
            .await;
        }
        Some("cli") => {
            use acid_cat_core::cli::{CliOptions, run_cli_process};
            let code = run_cli_process(
                app,
                context,
                CliOptions::new("fixture", "0.0.0"),
                args[1..].to_vec(),
            )
            .await;
            std::process::exit(code);
        }
        Some("cli-remote") => {
            use acid_cat_core::cli::{CliOptions, run_cli_process};
            use acid_cat_core::http::HttpClient;
            let url = args.get(1).expect("the URL of the server");
            let client = HttpClient::new(url).expect("an http URL");
            let code = run_cli_process(
                app,
                context,
                CliOptions::new("fixture", "0.0.0").remote(client),
                args[2..].to_vec(),
            )
            .await;
            std::process::exit(code);
        }
        Some("cli-blocking") => {
            use acid_cat_core::cli::{CliOptions, run_cli_process};
            record_the_thread_of_the_exit();
            let context = Fixture {
                holds: Holds {
                    blocks_its_thread: true,
                    holds_interrupt_until_go: std::env::var_os("FIXTURE_HOLD_INTERRUPT_UNTIL_GO")
                        .is_some(),
                    ..Holds::default()
                },
                ..Fixture::default()
            };
            let code = run_cli_process(
                app,
                Arc::new(context),
                CliOptions::new("fixture", "0.0.0"),
                args[1..].to_vec(),
            )
            .await;
            std::process::exit(code);
        }
        _ => {
            eprintln!(
                "Usage: fixture <catalog|serve|mcp-stdio|cli|cli-blocking|cli-remote> [args]"
            );
            std::process::exit(2);
        }
    }
}

fn signing_key(kid: &str) -> Value {
    use base64::Engine;
    let seed: [u8; 32] = rand::random();
    json!({
        "kty": "OKP",
        "crv": "Ed25519",
        "kid": kid,
        "d": base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(seed),
    })
}

fn poll() -> acid_cat_core::mcp::PollOptions {
    acid_cat_core::mcp::PollOptions {
        buffer_limit: fixture_settings::POLL_BUFFER,
        ..Default::default()
    }
}

unsafe extern "C" {
    fn atexit(callback: extern "C" fn()) -> std::ffi::c_int;
}

/// With `FIXTURE_EXIT_RECORD`, write the name of the thread that exits the process to that path, so that a test can tell
/// the exit at a second interrupt from the exit after the grace period. Both exit with code 130.
fn record_the_thread_of_the_exit() {
    extern "C" fn record() {
        if let Some(path) = std::env::var_os("FIXTURE_EXIT_RECORD") {
            let _ = std::fs::write(path, std::thread::current().name().unwrap_or("unnamed"));
        }
    }
    // SAFETY: `atexit` of the C library takes a function with no arguments, and `std::process::exit` calls it.
    unsafe {
        atexit(record);
    }
}
