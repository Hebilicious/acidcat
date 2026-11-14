//! The MCP binding through standard input and standard output (spec/bindings/mcp.md#stdio). The process is one
//! session. The server serves revision 2026-07-28, and the `initialize` handshake of revisions 2025-11-25 and
//! 2025-06-18.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use super::poll::{PollLeases, PollOptions};
use super::{
    EventStream, HANDSHAKE_VERSIONS, OpenSession, PROTOCOL_VERSION, PROTOCOL_VERSION_KEY, RpcError,
    SUBSCRIPTION_ID_KEY, call_tool, capabilities, codes, list_events, list_tools, response,
    server_info, serves_events,
};
use crate::app::Application;
use crate::remote::KEEPALIVE;
use crate::session::{DEFAULT_BUFFER_LIMIT, Session};

/// The number of lines that wait for standard output. When the client stops reading, the queue fills, and the tasks
/// that write wait. Then each subscription stops reading its occurrences, and its bounded buffer drops the oldest ones
/// and marks the next one `truncated` (spec/events.md#slow-clients).
const OUTPUT_QUEUE: usize = 64;

/// The settings of the MCP binding through stdio.
#[derive(Clone, Debug)]
pub struct McpStdioOptions {
    pub name: String,
    pub version: String,
    /// Guidance for a model about the whole server. The default is the description of the application.
    pub instructions: Option<String>,
    /// The target that the server serves. The default is `mcp`.
    pub target: String,
    /// The time with nothing sent on an `events/stream` request after which the server sends a heartbeat.
    pub heartbeat: Duration,
    /// The number of occurrences that each subscription keeps for a client that reads slowly. The default is 256.
    pub buffer_limit: usize,
    /// The settings of poll delivery. Each lease has a session of its own. The leases have no identity, because the
    /// process serves one client.
    pub poll: PollOptions,
}

impl McpStdioOptions {
    pub fn new(name: impl Into<String>, version: impl Into<String>) -> Self {
        McpStdioOptions {
            name: name.into(),
            version: version.into(),
            instructions: None,
            target: "mcp".into(),
            heartbeat: KEEPALIVE,
            buffer_limit: DEFAULT_BUFFER_LIMIT,
            poll: PollOptions::default(),
        }
    }
}

/// Serve the MCP server on the standard input and output of the process, until standard input ends. The logs go to
/// standard error.
pub async fn serve_stdio<C: Send + Sync + 'static>(
    app: Arc<Application<C>>,
    context: Arc<C>,
    options: McpStdioOptions,
) {
    run_stdio(
        app,
        context,
        options,
        tokio::io::stdin(),
        tokio::io::stdout(),
    )
    .await;
}

/// Serve the MCP server on the lines of `input` until the input ends. Then the session closes: the calls in progress
/// are cancelled, and the function returns when the last messages are written.
pub async fn run_stdio<C, R, W>(
    app: Arc<Application<C>>,
    context: Arc<C>,
    options: McpStdioOptions,
    input: R,
    mut output: W,
) where
    C: Send + Sync + 'static,
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (sender, mut lines) = mpsc::channel::<String>(OUTPUT_QUEUE);
    let writer = tokio::spawn(async move {
        while let Some(line) = lines.recv().await {
            if output.write_all(line.as_bytes()).await.is_err() || output.flush().await.is_err() {
                return;
            }
        }
    });
    let session =
        Session::with_buffer_limit(&app, &options.target, context.clone(), options.buffer_limit);
    let open: OpenSession<C> = {
        let (app, context, target, limit) = (
            app.clone(),
            context.clone(),
            options.target.clone(),
            options.buffer_limit,
        );
        Arc::new(move || Session::with_buffer_limit(&app, &target, context.clone(), limit))
    };
    let instructions = options
        .instructions
        .clone()
        .or_else(|| app.description().map(str::to_owned));
    let server = Arc::new(Server {
        listed: Mutex::new(available_ids(&session)),
        session,
        open,
        leases: PollLeases::new(options.poll.clone()),
        instructions,
        options,
        sender,
        calls: Mutex::new(HashMap::new()),
        streams: Mutex::new(HashMap::new()),
        listens: Mutex::new(HashSet::new()),
        initialized: AtomicBool::new(false),
        tasks: TaskTracker::new(),
    });
    let mut changes = server.session.availability_changes();
    let announcing = server.clone();
    let announcer = tokio::spawn(async move {
        while changes.recv().await.is_some() {
            announcing.announce().await;
        }
    });

    let mut reader = BufReader::new(input);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) => server.receive(&String::from_utf8_lossy(&line)),
        }
    }

    // Standard input ended: close the session, stop the leases, and cancel the calls in progress.
    server.leases.close();
    server
        .listens
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clear();
    for token in server
        .calls
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .values()
    {
        token.cancel();
    }
    server.session.close();
    announcer.abort();
    server.tasks.close();
    server.tasks.wait().await;
    drop(server);
    let _ = writer.await;
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The ids of the available tools, as one string, to compare two sets.
fn available_ids<C: Send + Sync + 'static>(session: &Session<C>) -> String {
    session
        .capability_ids()
        .iter()
        .filter(|id| {
            session
                .availability(id)
                .is_some_and(|availability| availability.is_available())
        })
        .cloned()
        .collect::<Vec<_>>()
        .join("\n")
}

/// The state of the one session of the process.
struct Server<C> {
    session: Session<C>,
    open: OpenSession<C>,
    leases: Arc<PollLeases>,
    instructions: Option<String>,
    options: McpStdioOptions,
    /// The queue of standard output. A send waits while the queue is full.
    sender: mpsc::Sender<String>,
    /// The calls in progress, by the JSON of the request id. `notifications/cancelled` cancels them.
    calls: Mutex<HashMap<String, CancellationToken>>,
    /// The `events/stream` requests in progress, by the JSON of the request id.
    streams: Mutex<HashMap<String, CancellationToken>>,
    /// The ids of the open `subscriptions/listen` requests that asked for tool list changes.
    listens: Mutex<HashSet<String>>,
    /// True after the `initialize` handshake: the client then gets `notifications/tools/list_changed`.
    initialized: AtomicBool,
    listed: Mutex<String>,
    tasks: TaskTracker,
}

impl<C: Send + Sync + 'static> Server<C> {
    /// Write one message to standard output. It waits while the queue of standard output is full.
    async fn send(&self, message: &Value) {
        let _ = self.sender.send(format!("{message}\n")).await;
    }

    async fn answer(&self, id: &Value, answer: Result<Value, RpcError>) {
        self.send(&response(id, answer)).await;
    }

    /// Answer a line that is not a request, in a task, so that the reader of standard input never waits for standard
    /// output.
    fn reject(self: &Arc<Self>, error: RpcError) {
        let server = self.clone();
        self.tasks
            .spawn(async move { server.answer(&Value::Null, Err(error)).await });
    }

    /// Read one line of standard input. An empty line is ignored. The reader does not wait: each request runs in a task.
    fn receive(self: &Arc<Self>, line: &str) {
        if line.trim().is_empty() {
            return;
        }
        let Ok(body) = serde_json::from_str::<Value>(line) else {
            return self.reject(RpcError::new(-32700, "The line is not JSON."));
        };
        let Some(object) = body.as_object() else {
            let message = if body.is_array() {
                "JSON-RPC batches are not supported."
            } else {
                "A message must be a JSON object."
            };
            return self.reject(RpcError::new(-32600, message));
        };
        let id = object.get("id").map(|id| {
            if id.is_string() || id.is_number() {
                id.clone()
            } else {
                Value::Null
            }
        });
        let params = object
            .get("params")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let Some(method) = object
            .get("method")
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            // A response of the client. The server sends no requests, so it reads none.
            if id.is_none() {
                self.reject(RpcError::new(-32600, "A message must have a method."));
            }
            return;
        };
        let Some(id) = id else {
            return self.notification(&method, &params);
        };
        // Register the token of a call or a stream now, before the task starts, so that a `notifications/cancelled`
        // on the next line finds it.
        let token = CancellationToken::new();
        let registry = self.registry(&method).filter(|_| !id.is_null());
        if let Some(registry) = registry {
            lock(registry).insert(id.to_string(), token.clone());
        }
        let server = self.clone();
        self.tasks.spawn(async move {
            let key = id.to_string();
            server.request(id, &method, params, token).await;
            if let Some(registry) = server.registry(&method) {
                lock(registry).remove(&key);
            }
        });
    }

    /// The map of the requests that `notifications/cancelled` can cancel, for a method that has one.
    fn registry(&self, method: &str) -> Option<&Mutex<HashMap<String, CancellationToken>>> {
        match method {
            "tools/call" => Some(&self.calls),
            "events/stream" => Some(&self.streams),
            _ => None,
        }
    }

    fn notification(&self, method: &str, params: &Map<String, Value>) {
        if method != "notifications/cancelled" {
            return;
        }
        let Some(request) = params
            .get("requestId")
            .filter(|id| id.is_string() || id.is_number())
        else {
            return;
        };
        let key = request.to_string();
        if let Some(token) = self
            .calls
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&key)
        {
            token.cancel();
        }
        if let Some(token) = self
            .streams
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&key)
        {
            token.cancel();
        }
        self.listens
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&key);
    }

    /// Answer one request. `token` is cancelled by `notifications/cancelled` for a `tools/call` or an `events/stream`
    /// request.
    async fn request(
        self: &Arc<Self>,
        id: Value,
        method: &str,
        params: Map<String, Value>,
        token: CancellationToken,
    ) {
        let meta_version = params
            .get("_meta")
            .and_then(|meta| meta.get(PROTOCOL_VERSION_KEY))
            .cloned();
        let supported = json!([
            PROTOCOL_VERSION,
            HANDSHAKE_VERSIONS[0],
            HANDSHAKE_VERSIONS[1]
        ]);
        match method {
            "initialize" => return self.initialize(&id, &params).await,
            "ping" => return self.answer(&id, Ok(json!({}))).await,
            _ => {}
        }
        let modern = meta_version.is_some();
        if let Some(version) = &meta_version
            && version.as_str() != Some(PROTOCOL_VERSION)
        {
            let error = RpcError::new(-32022, format!("Unsupported protocol version {version}"))
                .with_data(json!({ "supported": supported }));
            return self.answer(&id, Err(error)).await;
        }
        let meta = server_info(&self.options.name, &self.options.version);
        let complete = |result: Value, list: bool| -> Value {
            if !modern {
                return result;
            }
            let mut answer = json!({ "_meta": meta, "resultType": "complete" });
            if list {
                answer["ttlMs"] = json!(0);
                answer["cacheScope"] = json!("private");
            }
            if let (Some(answer), Value::Object(result)) = (answer.as_object_mut(), result) {
                answer.extend(result);
            }
            answer
        };
        let session = &self.session;
        match method {
            "server/discover" => {
                let mut result = json!({ "supportedVersions": supported, "capabilities": capabilities(session, true) });
                if let Some(instructions) = &self.instructions {
                    result["instructions"] = json!(instructions);
                }
                return self.answer(&id, Ok(complete(result, true))).await;
            }
            "subscriptions/listen" => return self.listen(&id, &params).await,
            "tools/list" => {
                return self
                    .answer(
                        &id,
                        Ok(complete(json!({ "tools": list_tools(session) }), true)),
                    )
                    .await;
            }
            "tools/call" => {
                let answer = call_tool(session, &params, &token).await;
                // The server does not answer a cancelled request.
                if !token.is_cancelled() {
                    self.answer(&id, answer.map(|result| complete(result, false)))
                        .await;
                }
                return;
            }
            _ => {}
        }
        // The events extension is only for revision 2026-07-28, and only when the view has events.
        if modern && serves_events(session) {
            match method {
                "events/list" => {
                    let events = json!({ "events": list_events(session, false) });
                    return self.answer(&id, Ok(complete(events, true))).await;
                }
                "events/poll" => {
                    let answer = self.leases.poll(None, &params, &self.open);
                    let answer = answer.map(|result| complete(Value::Object(result), false));
                    return self.answer(&id, answer).await;
                }
                "events/subscribe" | "events/unsubscribe" => {
                    return self.answer(&id, Err(RpcError::unsupported_webhook())).await;
                }
                "events/stream" if !id.is_null() => {
                    return self.stream(id, &params, meta.clone(), token).await;
                }
                _ => {}
            }
        }
        let error = RpcError::new(
            codes::METHOD_NOT_FOUND,
            format!("Method not found: {method}"),
        );
        self.answer(&id, Err(error)).await;
    }

    /// An `events/stream` request: the messages of the subscription go to standard output. `notifications/cancelled`
    /// with the id of the request cancels `token`, and then the server sends nothing more for it. While standard output
    /// is full, the stream reads no occurrences, so the buffer of the subscription fills and drops the oldest ones.
    async fn stream(
        &self,
        id: Value,
        params: &Map<String, Value>,
        meta: Value,
        token: CancellationToken,
    ) {
        if token.is_cancelled() {
            return;
        }
        let started = EventStream::start(
            &self.session,
            id.clone(),
            params,
            meta,
            self.options.heartbeat,
        );
        let mut stream = match started {
            Ok(stream) => stream,
            Err(error) => return self.answer(&id, Err(error)).await,
        };
        loop {
            let messages = tokio::select! {
                () = token.cancelled() => return,
                messages = stream.next() => messages,
            };
            let Some(messages) = messages else { return };
            for message in &messages {
                tokio::select! {
                    () = token.cancelled() => return,
                    () = self.send(message) => {}
                }
            }
        }
    }

    /// The `initialize` handshake. The server selects the revision of the client if it serves it, or else its latest.
    async fn initialize(&self, id: &Value, params: &Map<String, Value>) {
        let offered = params.get("protocolVersion").and_then(Value::as_str);
        let version = HANDSHAKE_VERSIONS
            .iter()
            .find(|each| Some(**each) == offered)
            .unwrap_or(&HANDSHAKE_VERSIONS[0]);
        let mut result = json!({
            "protocolVersion": version,
            "capabilities": { "tools": { "listChanged": true } },
            "serverInfo": { "name": self.options.name, "version": self.options.version },
        });
        if let Some(instructions) = &self.instructions {
            result["instructions"] = json!(instructions);
        }
        self.answer(id, Ok(result)).await;
        self.initialized.store(true, Ordering::SeqCst);
    }

    /// A `subscriptions/listen` request of revision 2026-07-28. The server honors only tool list changes. The request
    /// stays open until the client cancels it or standard input ends, so the server never answers it.
    async fn listen(&self, id: &Value, params: &Map<String, Value>) {
        let tools = params
            .get("notifications")
            .and_then(|wanted| wanted.get("toolsListChanged"))
            == Some(&json!(true))
            && !id.is_null();
        self.send(&json!({
            "jsonrpc": "2.0",
            "method": "notifications/subscriptions/acknowledged",
            "params": { "_meta": { SUBSCRIPTION_ID_KEY: id }, "notifications": if tools { json!({ "toolsListChanged": true }) } else { json!({}) } },
        }))
        .await;
        if tools {
            self.listens
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(id.to_string());
        }
    }

    /// Tell the client when the set of available tools changes.
    async fn announce(&self) {
        let next = available_ids(&self.session);
        {
            let mut listed = self
                .listed
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if *listed == next {
                return;
            }
            *listed = next;
        }
        if self.initialized.load(Ordering::SeqCst) {
            self.send(&json!({ "jsonrpc": "2.0", "method": "notifications/tools/list_changed", "params": {} }))
                .await;
        }
        let listens: Vec<String> = self
            .listens
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .cloned()
            .collect();
        for id in listens {
            let id: Value = serde_json::from_str(&id).unwrap_or(Value::Null);
            self.send(&json!({ "jsonrpc": "2.0", "method": "notifications/tools/list_changed", "params": { "_meta": { SUBSCRIPTION_ID_KEY: id } } }))
                .await;
        }
    }
}
