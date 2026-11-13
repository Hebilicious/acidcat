//! The conformance fixture (packages/cli/conformance/fixture.pkl), served by the Rust core. `acid-cat conform` tests
//! it through each binding.
//!
//! ```sh
//! cargo run --example fixture -- serve        # MCP at /mcp and HTTP at /api; writes the base URL on the first line
//! cargo run --example fixture -- mcp-stdio    # MCP through standard input and standard output
//! cargo run --example fixture -- cli <args>   # the command line
//! cargo run --example fixture -- catalog      # the catalog in canonical form
//! ```

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use acid_cat_core::{App, Application, Availability, Defect, Emitted, fail};

/// The capabilities and the events of the fixture get its services.
type Capability = acid_cat_core::Capability<Fixture>;
type Event = acid_cat_core::Event<Fixture>;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio::sync::{Notify, mpsc, watch};

/// The services of the fixture. All the sessions of one provider share them.
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

/// The calls to `fixture.hold` that hold now.
#[derive(Default)]
struct Holds {
    next: AtomicU64,
    holding: Mutex<HashMap<u64, (String, Arc<Notify>)>>,
}

impl Holds {
    /// Hold until `release` releases the key. When the call is cancelled, the core drops this future, and the key
    /// leaves `held`.
    async fn hold(&self, key: String, marker: Option<String>) {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let released = Arc::new(Notify::new());
        self.holding
            .lock()
            .unwrap()
            .insert(id, (key, released.clone()));
        let _forget = Forget(|| {
            self.holding.lock().unwrap().remove(&id);
        });
        if let Some(marker) = marker {
            let _ = std::fs::write(marker, "");
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

/// The subscriptions to `fixture.watch` that are active now.
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

    /// Give the value to each watch of the key. The result is the number of these watches.
    fn signal(&self, key: &str, value: &str) -> usize {
        self.watching
            .lock()
            .unwrap()
            .values()
            .filter(|(watched, sender)| watched == key && sender.send(value.to_owned()).is_ok())
            .count()
    }
}

/// Calls a function when it is dropped.
struct Forget<F: FnMut()>(F);

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
    on: bool,
}

#[derive(Deserialize, JsonSchema)]
#[schemars(transform = with_no_properties)]
struct Nothing {}

/// An input schema with `"properties": {}`: an input that takes no properties.
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

#[derive(Deserialize, JsonSchema)]
struct Ticks {
    #[schemars(range(min = 0, max = 100))]
    count: i64,
    #[schemars(range(min = 1, max = 100))]
    gap: Option<i64>,
    #[allow(dead_code)]
    key: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct Watch {
    key: String,
    marker: Option<String>,
}

const EVERYWHERE: [&str; 4] = ["app", "mcp", "cli", "api"];

/// The fixture application.
pub fn fixture() -> Arc<Application<Fixture>> {
    App::new()
        .title("Fixture")
        .description("One capability or event for each behavior that acid-cat conform tests.")
        .target("app", ["typescript", "webmcp"])
        .target("mcp", ["mcp"])
        .target("cli", ["cli"])
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
                "Hold until fixture.release releases the key, then return the key. While the call holds, fixture.held gives the key. With a marker, the call writes a file at that path when it starts to hold.",
            )
            .audience(EVERYWHERE)
            .input::<Hold>()
            .output::<Key>()
            .run(|Hold { key, marker }, call| async move {
                call.context().holds.hold(key.clone(), marker).await;
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
                // A cursor that is not a count starts at the first tick.
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
                "Give an occurrence each time that fixture.signal gets the key. Never end. With a marker, write a file at that path when the subscription starts.",
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
                    if let Some(marker) = marker {
                        let _ = std::fs::write(marker, "");
                    }
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
            use acid_cat_core::http::{HttpBinding, HttpOptions};
            use acid_cat_core::mcp::{McpBinding, McpOptions, Principal, WebhookOptions};
            let http = HttpBinding::new(
                app.clone(),
                context.clone(),
                HttpOptions {
                    base: "/api".into(),
                    ..HttpOptions::default()
                },
            );
            // With `--webhook-ca <file>`, webhook delivery is on, and it trusts the certificate of the receiver of conform.
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
                    min_ttl: std::time::Duration::from_millis(1000),
                    max_ttl: std::time::Duration::from_millis(5000),
                    max_subscriptions: 3,
                    ..WebhookOptions::default()
                });
            // The principal of a request is the token of the header `Authorization: Bearer <principal>`.
            let principal: Principal = Arc::new(|headers| {
                headers
                    .get("authorization")?
                    .to_str()
                    .ok()?
                    .strip_prefix("Bearer ")
                    .map(str::to_owned)
            });
            let mcp = McpBinding::new(
                app.clone(),
                context.clone(),
                McpOptions {
                    poll: poll(),
                    principal: Some(principal),
                    webhooks,
                    ..McpOptions::new("fixture", "0.0.0")
                },
            );
            let routes: acid_cat_core::remote::Routes = vec![
                ("/api".into(), Arc::new(http)),
                ("/mcp".into(), Arc::new(mcp)),
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
        _ => {
            eprintln!("Usage: fixture <catalog|serve|mcp-stdio|cli> [args]");
            std::process::exit(2);
        }
    }
}

/// The poll settings of the fixture: a small buffer and a short lease time, so that conform can test both. The tests
/// give the same settings to conform.
fn poll() -> acid_cat_core::mcp::PollOptions {
    acid_cat_core::mcp::PollOptions {
        buffer_limit: 5,
        lease: std::time::Duration::from_millis(2000),
        ..Default::default()
    }
}
