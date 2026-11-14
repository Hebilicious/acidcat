//! Tests of behaviors that `acid-cat conform` cannot check well: the order of the call failures of the command line,
//! the cancellation of a stdio request on the next line, and standard output that the client stops reading.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use acid_cat_core::cli::{CliIo, CliOptions, exit, run_cli};
use acid_cat_core::mcp::{McpStdioOptions, PROTOCOL_VERSION, run_stdio};
use acid_cat_core::{App, Application, Availability, Emitted};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, Lines};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

type Capability = acid_cat_core::Capability<Services>;
type Event = acid_cat_core::Event<Services>;

/// The services of the test application.
struct Services {
    /// The availability of `test.off`. It is unavailable.
    switch: watch::Sender<Availability>,
    /// The number of calls to `test.hold` that hold now.
    holding: AtomicUsize,
}

impl Default for Services {
    fn default() -> Self {
        Services {
            switch: watch::Sender::new(Availability::unavailable("The switch is off.")),
            holding: AtomicUsize::new(0),
        }
    }
}

/// Calls a function when it is dropped.
struct OnDrop<F: FnMut()>(F);

impl<F: FnMut()> Drop for OnDrop<F> {
    fn drop(&mut self) {
        (self.0)();
    }
}

#[derive(Serialize, Deserialize, JsonSchema)]
struct Text {
    text: String,
}

#[derive(Serialize, JsonSchema)]
struct Tick {
    n: i64,
}

/// The number of occurrences of `test.slow`.
const SLOW_TICKS: i64 = 300;

fn application() -> Arc<Application<Services>> {
    App::new()
        .title("Test")
        .target("cli", ["cli"])
        .target("mcp", ["mcp"])
        .capability(
            Capability::new("test.echo", "Return the input text.")
                .audience(["cli", "mcp"])
                .input::<Text>()
                .output::<Text>()
                .run(|input, _| async move { Ok(input) }),
        )
        .capability(
            Capability::new("test.off", "Never available.")
                .audience(["cli", "mcp"])
                .input::<Text>()
                .availability(|context: &Services| context.switch.subscribe())
                .run(|_: Text, _| async move { Ok(()) }),
        )
        .capability(
            Capability::new("test.hold", "Hold until the call is cancelled.")
                .audience(["mcp"])
                .run(|(), call| async move {
                    let context = call.context_arc();
                    context.holding.fetch_add(1, Ordering::SeqCst);
                    let _released = OnDrop(move || {
                        context.holding.fetch_sub(1, Ordering::SeqCst);
                    });
                    std::future::pending::<()>().await;
                    Ok(())
                }),
        )
        .event(
            Event::new(
                "test.slow",
                "Give the occurrences n = 1 to 300, one each millisecond.",
            )
            .audience(["mcp"])
            .payload::<Tick>()
            .subscribe(|(), _| {
                futures::stream::unfold(1, |n| async move {
                    if n > SLOW_TICKS {
                        return None;
                    }
                    tokio::time::sleep(Duration::from_millis(1)).await;
                    Some((Ok(Emitted::new(Tick { n })), n + 1))
                })
            }),
        )
        .build()
        .unwrap_or_else(|problems| panic!("the application does not conform: {problems:?}"))
}

/// Run the command line, and give its exit code and what it wrote.
async fn cli(args: &[&str]) -> (i32, String) {
    let written = Arc::new(Mutex::new(String::new()));
    let (stdout, stderr) = (written.clone(), written.clone());
    let mut io = CliIo {
        stdout: Box::new(move |text| stdout.lock().unwrap().push_str(text)),
        stderr: Box::new(move |text| stderr.lock().unwrap().push_str(text)),
        cancel: CancellationToken::new(),
    };
    let args: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
    let code = run_cli(
        &application(),
        Arc::new(Services::default()),
        &CliOptions::new("test", "0.0.0"),
        &args,
        &mut io,
    )
    .await
    .expect("the commands follow the rules");
    let text = written.lock().unwrap().clone();
    (code, text)
}

#[tokio::test]
async fn the_command_line_checks_the_id_and_the_availability_before_the_json_text() {
    let (code, text) = cli(&["call", "no.such", "{bad"]).await;
    assert_eq!(code, exit::UNKNOWN_CAPABILITY, "{text}");
    assert!(text.contains("unknown-capability"), "{text}");

    let (code, text) = cli(&["call", "test.off", "{bad"]).await;
    assert_eq!(code, exit::UNAVAILABLE, "{text}");
    assert!(text.contains("unavailable"), "{text}");

    let (code, text) = cli(&["call", "test.echo", "{bad"]).await;
    assert_eq!(code, exit::INVALID_INPUT, "{text}");
    assert!(text.contains("invalid-input"), "{text}");
}

/// A client of the stdio server: it writes lines to standard input, and reads lines of standard output.
struct Client {
    input: DuplexStream,
    output: Lines<BufReader<DuplexStream>>,
    server: tokio::task::JoinHandle<()>,
}

impl Client {
    /// Start the stdio server. `output_bytes` is the size of the pipe of standard output.
    fn start(context: Arc<Services>, output_bytes: usize) -> Client {
        let (input, server_input) = tokio::io::duplex(64 * 1024);
        let (server_output, output) = tokio::io::duplex(output_bytes);
        let options = McpStdioOptions {
            buffer_limit: 4,
            ..McpStdioOptions::new("test", "0.0.0")
        };
        let server = tokio::spawn(run_stdio(
            application(),
            context,
            options,
            server_input,
            server_output,
        ));
        Client {
            input,
            output: BufReader::new(output).lines(),
            server,
        }
    }

    async fn write(&mut self, messages: &[Value]) {
        let text: String = messages
            .iter()
            .map(|message| format!("{message}\n"))
            .collect();
        self.input
            .write_all(text.as_bytes())
            .await
            .expect("the server reads");
    }

    async fn read(&mut self) -> Value {
        let line = tokio::time::timeout(Duration::from_secs(10), self.output.next_line())
            .await
            .expect("the server writes in time")
            .expect("standard output can be read")
            .expect("standard output is open");
        serde_json::from_str(&line).expect("each line is JSON")
    }

    /// Read lines until the responses to the requests `ids`. The result is all the lines that the client read.
    async fn read_until_responses(&mut self, ids: &[i64]) -> Vec<Value> {
        let mut messages = Vec::new();
        let mut waiting: Vec<i64> = ids.to_vec();
        while !waiting.is_empty() {
            let message = self.read().await;
            if message.get("method").is_none() {
                waiting.retain(|id| message.get("id") != Some(&json!(id)));
            }
            messages.push(message);
        }
        messages
    }

    async fn close(self) {
        drop(self.input);
        let Client { output, server, .. } = self;
        // Read the rest of standard output, so that the server can end.
        let reading = tokio::spawn(async move {
            let mut output = output;
            while let Ok(Some(_)) = output.next_line().await {}
        });
        tokio::time::timeout(Duration::from_secs(10), server)
            .await
            .expect("the server ends")
            .expect("the server does not panic");
        let _ = reading.await;
    }
}

fn request(id: i64, method: &str, params: Value) -> Value {
    let mut params = params.as_object().cloned().unwrap_or_else(Map::new);
    params.insert(
        "_meta".into(),
        json!({ "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION }),
    );
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancellation_on_the_line_after_its_request_cancels_the_call() {
    for _ in 0..20 {
        let context = Arc::new(Services::default());
        let mut client = Client::start(context.clone(), 64 * 1024);
        client
            .write(&[
                request(1, "tools/call", json!({ "name": "test.hold" })),
                json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": 1 } }),
                request(2, "ping", json!({})),
            ])
            .await;
        // The server does not answer a cancelled request: the next answer is the one to the ping.
        let answer = client.read().await;
        assert_eq!(answer.get("id"), Some(&json!(2)), "{answer}");
        // The call never started, or it started and the cancellation ended it.
        let ended = tokio::time::timeout(Duration::from_secs(5), async {
            while context.holding.load(Ordering::SeqCst) > 0 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await;
        assert!(ended.is_ok(), "the cancellation ends the call");
        client.close().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_client_that_stops_reading_gets_truncated_occurrences_and_still_gets_answers() {
    let mut client = Client::start(Arc::new(Services::default()), 1024);
    client
        .write(&[request(1, "events/stream", json!({ "name": "test.slow" }))])
        .await;
    // Do not read while the provider gives all its occurrences.
    tokio::time::sleep(Duration::from_millis(
        u64::try_from(SLOW_TICKS).unwrap_or(300) * 3,
    ))
    .await;
    client.write(&[request(2, "ping", json!({}))]).await;

    let messages = client.read_until_responses(&[1, 2]).await;
    let response = |id: i64| {
        messages
            .iter()
            .find(|message| {
                message.get("id") == Some(&json!(id)) && message.get("method").is_none()
            })
            .cloned()
            .unwrap_or_default()
    };
    assert!(response(1).get("result").is_some(), "the stream ends");
    assert_eq!(
        response(2).get("result"),
        Some(&json!({})),
        "the ping gets its answer"
    );
    let events = messages
        .iter()
        .filter(|message| message["method"] == "notifications/events/event")
        .count();
    let truncated = messages.iter().any(|message| {
        message["method"] == "notifications/events/active" && message["params"]["truncated"] == true
    });
    assert!(
        truncated,
        "the buffer of the subscription dropped occurrences"
    );
    assert!(
        events < usize::try_from(SLOW_TICKS).unwrap_or(0),
        "{events} occurrences were kept for a client that did not read"
    );
    client.close().await;
}
