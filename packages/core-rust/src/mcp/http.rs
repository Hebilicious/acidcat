//! The MCP binding through HTTP (spec/bindings/mcp.md#http), revision 2026-07-28, and the `initialize` handshake of
//! earlier revisions (spec/bindings/mcp.md#earlier-revisions-through-http). The server keeps no state between
//! requests, except poll leases and webhook subscriptions.

use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use http::{HeaderMap, HeaderValue, Method, Request, Response, header};
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use super::poll::{PollLeases, PollOptions};
use super::webhook::{WebhookOptions, Webhooks};
use super::{
    EventStream, HANDSHAKE_VERSIONS, OpenSession, PROTOCOL_VERSION, PROTOCOL_VERSION_KEY, RpcError,
    call_tool, capabilities, codes, list_events, list_tools, response, server_info, serves_events,
};
use crate::app::Application;
use crate::http::async_stream;
use crate::remote::{
    Contexts, DEFAULT_MAXIMUM_BYTES, Handler, KEEPALIVE, OnDrop, Refusal, Rejection, RequestBody,
    ResponseBody, Rules, empty_response, header_text, json_response, read_request, sse_message,
    sse_response,
};
use crate::session::{DEFAULT_BUFFER_LIMIT, Session};

/// The identity of the client of a request, from its headers: the principal (spec/bindings/mcp.md#webhook).
pub type Principal = Arc<dyn Fn(&HeaderMap) -> Option<String> + Send + Sync>;

/// The settings of the MCP binding through HTTP.
#[derive(Clone)]
pub struct McpOptions {
    pub name: String,
    pub version: String,
    /// Guidance for a model about the whole server. The default is the description of the application.
    pub instructions: Option<String>,
    /// The origins that can call the server. A request with no `Origin` header is accepted.
    pub allowed_origins: Vec<String>,
    /// The target that the server serves. The default is `mcp`.
    pub target: String,
    /// The maximum size of a request body, in bytes. The default is 1 MiB.
    pub maximum_bytes: usize,
    /// The time with nothing sent on an `events/stream` response after which the server sends a heartbeat.
    pub heartbeat: Duration,
    /// The number of occurrences that each subscription keeps for a client that reads slowly. The default is 256.
    pub buffer_limit: usize,
    /// Serve the `initialize` handshake of revisions 2025-11-25 and 2025-06-18. The default is `true`.
    pub handshake: bool,
    /// The settings of poll delivery.
    pub poll: PollOptions,
    /// The identity of the client of a request. It is part of the key of a poll lease and of a webhook subscription.
    /// With no function, no request has an identity.
    pub principal: Option<Principal>,
    /// Webhook delivery. It is off when this member is `None`.
    pub webhooks: Option<WebhookOptions>,
}

impl McpOptions {
    pub fn new(name: impl Into<String>, version: impl Into<String>) -> Self {
        McpOptions {
            name: name.into(),
            version: version.into(),
            instructions: None,
            allowed_origins: Vec::new(),
            target: "mcp".into(),
            maximum_bytes: DEFAULT_MAXIMUM_BYTES,
            heartbeat: KEEPALIVE,
            buffer_limit: DEFAULT_BUFFER_LIMIT,
            handshake: true,
            poll: PollOptions::default(),
            principal: None,
            webhooks: None,
        }
    }
}

struct Inner<C> {
    app: Arc<Application<C>>,
    context: Contexts<C>,
    options: McpOptions,
    instructions: Option<String>,
    leases: Arc<PollLeases>,
    webhooks: Option<Arc<Webhooks>>,
}

/// The MCP server of an application through HTTP. Each request has its own session. [`McpBinding::close`] ends the
/// poll leases and the webhook subscriptions.
pub struct McpBinding<C> {
    inner: Arc<Inner<C>>,
}

impl<C> Clone for McpBinding<C> {
    fn clone(&self) -> Self {
        McpBinding {
            inner: self.inner.clone(),
        }
    }
}

/// The members of a JSON-RPC request that the server reads.
struct Message {
    /// `None` for a notification. An `id` that is not a string or a number is `null`.
    id: Option<Value>,
    method: Option<String>,
    params: Map<String, Value>,
    meta_version: Option<Value>,
}

fn read_message(body: &Value) -> Message {
    let params = body
        .get("params")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let meta_version = params
        .get("_meta")
        .and_then(|meta| meta.get(PROTOCOL_VERSION_KEY))
        .cloned();
    Message {
        id: body
            .as_object()
            .and_then(|object| object.get("id"))
            .map(|id| {
                if id.is_string() || id.is_number() {
                    id.clone()
                } else {
                    Value::Null
                }
            }),
        method: body
            .get("method")
            .and_then(Value::as_str)
            .map(str::to_owned),
        params,
        meta_version,
    }
}

impl<C: Send + Sync + 'static> McpBinding<C> {
    /// A binding whose requests share one context.
    pub fn new(app: Arc<Application<C>>, context: Arc<C>, options: McpOptions) -> Self {
        Self::with_contexts(app, Contexts::Shared(context), options)
    }

    /// A binding that makes a context for each request that passes the screening, from the head of the request: for
    /// example the caller, from a token in a header. A [`Refusal`] answers the request instead. A poll lease or a
    /// webhook subscription keeps the context of the request that started it, until it ends.
    pub fn with_request_context<Make, Made>(
        app: Arc<Application<C>>,
        make: Make,
        options: McpOptions,
    ) -> Self
    where
        Make: Fn(&http::request::Parts) -> Made + Send + Sync + 'static,
        Made: std::future::Future<Output = Result<C, Refusal>> + Send + 'static,
    {
        Self::with_contexts(app, Contexts::per_request(make), options)
    }

    fn with_contexts(app: Arc<Application<C>>, context: Contexts<C>, options: McpOptions) -> Self {
        let instructions = options
            .instructions
            .clone()
            .or_else(|| app.description().map(str::to_owned));
        let leases = PollLeases::new(options.poll.clone());
        let webhooks = options.webhooks.clone().map(Webhooks::new);
        McpBinding {
            inner: Arc::new(Inner {
                app,
                context,
                options,
                instructions,
                leases,
                webhooks,
            }),
        }
    }

    /// End the poll leases and the webhook subscriptions.
    pub async fn close(&self) {
        self.inner.leases.close();
        if let Some(webhooks) = &self.inner.webhooks {
            webhooks.close().await;
        }
    }

    /// Open sessions with the context of one request.
    fn open(&self, context: &Arc<C>) -> OpenSession<C> {
        let inner = self.inner.clone();
        let context = context.clone();
        Arc::new(move || {
            Session::with_buffer_limit(
                &inner.app,
                &inner.options.target,
                context.clone(),
                inner.options.buffer_limit,
            )
        })
    }

    fn meta(&self) -> Value {
        server_info(&self.inner.options.name, &self.inner.options.version)
    }

    /// Answer one request.
    pub async fn handle(&self, request: Request<RequestBody>) -> Response<ResponseBody> {
        let options = &self.inner.options;
        let rules = Rules {
            methods: &[Method::POST],
            allowed_origins: &options.allowed_origins,
            maximum_bytes: options.maximum_bytes,
        };
        let (parts, text) = match read_request(request, &rules).await {
            Ok(read) => read,
            Err(rejection) => return rejected(rejection),
        };
        let Ok(body) = serde_json::from_str::<Value>(&text) else {
            return rejected(Rejection::NotUtf8);
        };
        let context = match self.inner.context.open(&parts).await {
            Ok(context) => context,
            Err(refusal) => return refusal.response(),
        };
        let message = read_message(&body);
        let header = header_text(&parts.headers, "mcp-protocol-version");
        let handshake = match header {
            None => message.meta_version.as_ref().and_then(Value::as_str) != Some(PROTOCOL_VERSION),
            Some(version) => HANDSHAKE_VERSIONS.contains(&version),
        };
        if options.handshake && handshake {
            return self.handshake(message, &context).await;
        }

        // Revision 2026-07-28: each request names its revision in a header, and repeats it in `_meta`.
        let id = message.id.clone().unwrap_or(Value::Null);
        let Some(version) = header else {
            return rpc(
                400,
                &id,
                Err(RpcError::new(
                    -32020,
                    "MCP-Protocol-Version header is required",
                )),
            );
        };
        if version != PROTOCOL_VERSION {
            return rpc(
                400,
                &id,
                Err(
                    RpcError::new(-32022, format!("Unsupported protocol version {version}"))
                        .with_data(json!({ "supported": [PROTOCOL_VERSION] })),
                ),
            );
        }
        if message.id.is_none() {
            let mut answer = empty_response(200);
            answer.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            );
            return answer;
        }
        match &message.meta_version {
            None => {
                return rpc(
                    400,
                    &id,
                    Err(RpcError::invalid_params(
                        "Required request metadata is missing",
                    )),
                );
            }
            Some(meta) if meta.as_str() != Some(version) => {
                return rpc(
                    400,
                    &id,
                    Err(RpcError::new(
                        -32020,
                        "MCP-Protocol-Version header does not match request metadata",
                    )),
                );
            }
            Some(_) => {}
        }

        let session = (self.open(&context))();
        let close = session.clone();
        let guard = OnDrop(move || close.close());
        let method = message.method.as_deref().unwrap_or_default();
        let complete = |result: Map<String, Value>, list: bool| {
            let mut answer = json!({ "_meta": self.meta(), "resultType": "complete" });
            if list {
                answer["ttlMs"] = json!(0);
                answer["cacheScope"] = json!("private");
            }
            answer
                .as_object_mut()
                .into_iter()
                .for_each(|object| object.extend(result.clone()));
            rpc(200, &id, Ok(answer))
        };
        let events = serves_events(&session);
        match method {
            "server/discover" => {
                let mut result = Map::new();
                result.insert("supportedVersions".into(), json!([PROTOCOL_VERSION]));
                result.insert("capabilities".into(), capabilities(&session, false));
                if let Some(instructions) = &self.inner.instructions {
                    result.insert("instructions".into(), json!(instructions));
                }
                complete(result, true)
            }
            "tools/list" => complete(
                Map::from_iter([("tools".into(), Value::Array(list_tools(&session)))]),
                true,
            ),
            "tools/call" => {
                match call_tool(&session, &message.params, &CancellationToken::new()).await {
                    Ok(Value::Object(result)) => complete(result, false),
                    Ok(_) => rpc(
                        200,
                        &id,
                        Err(RpcError::new(codes::INTERNAL, "The server gave no result.")),
                    ),
                    Err(error) => rpc(200, &id, Err(error)),
                }
            }
            "events/list" if events => complete(
                Map::from_iter([(
                    "events".into(),
                    Value::Array(list_events(&session, self.inner.webhooks.is_some())),
                )]),
                true,
            ),
            "events/stream" if events && !id.is_null() => {
                let mut stream = match EventStream::start(
                    &session,
                    id.clone(),
                    &message.params,
                    self.meta(),
                    options.heartbeat,
                ) {
                    Ok(stream) => stream,
                    Err(error) => return rpc(200, &id, Err(error)),
                };
                sse_response(async_stream(move |sender| async move {
                    let _guard = guard;
                    while let Some(messages) = stream.next().await {
                        let text: String = messages
                            .iter()
                            .map(|message| sse_message(None, None, &message.to_string()))
                            .collect();
                        if sender.send(text).await.is_err() {
                            return;
                        }
                    }
                }))
            }
            "events/poll" | "events/subscribe" | "events/unsubscribe" if events => {
                let principal = options
                    .principal
                    .as_ref()
                    .and_then(|principal| principal(&parts.headers));
                let answer = match (method, &self.inner.webhooks, &principal) {
                    ("events/poll", _, _) => self.inner.leases.poll(
                        principal.as_deref(),
                        &message.params,
                        &self.open(&context),
                    ),
                    (_, None, _) => Err(RpcError::unsupported_webhook()),
                    (_, Some(_), None) => Err(RpcError::new(codes::FORBIDDEN, "Forbidden")),
                    ("events/subscribe", Some(webhooks), Some(principal)) => {
                        webhooks
                            .subscribe(principal, &message.params, &self.open(&context))
                            .await
                    }
                    (_, Some(webhooks), Some(principal)) => {
                        webhooks.unsubscribe(principal, &message.params)
                    }
                };
                match answer {
                    Ok(result) => complete(result, false),
                    Err(error) => rpc(200, &id, Err(error)),
                }
            }
            _ => rpc(
                404,
                &id,
                Err(RpcError::new(
                    codes::METHOD_NOT_FOUND,
                    format!("Method not found: {method}"),
                )),
            ),
        }
    }

    /// Answer a request of a revision with an `initialize` handshake. The server keeps no state for the handshake.
    async fn handshake(&self, message: Message, context: &Arc<C>) -> Response<ResponseBody> {
        let Some(id) = message.id else {
            return empty_response(202);
        };
        let session = (self.open(context))();
        let _guard = OnDrop({
            let session = session.clone();
            move || session.close()
        });
        let answer = match message.method.as_deref().unwrap_or_default() {
            "initialize" => {
                let offered = message
                    .params
                    .get("protocolVersion")
                    .and_then(Value::as_str);
                let version = HANDSHAKE_VERSIONS
                    .iter()
                    .find(|each| Some(**each) == offered)
                    .unwrap_or(&HANDSHAKE_VERSIONS[0]);
                let mut result = json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": self.inner.options.name, "version": self.inner.options.version },
                });
                if let Some(instructions) = &self.inner.instructions {
                    result["instructions"] = json!(instructions);
                }
                Ok(result)
            }
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": list_tools(&session) })),
            "tools/call" => call_tool(&session, &message.params, &CancellationToken::new()).await,
            method => Err(RpcError::new(
                codes::METHOD_NOT_FOUND,
                format!("Method not found: {method}"),
            )),
        };
        rpc(200, &id, answer)
    }
}

impl<C: Send + Sync + 'static> Handler for McpBinding<C> {
    fn handle(&self, request: Request<RequestBody>) -> BoxFuture<'static, Response<ResponseBody>> {
        let binding = self.clone();
        Box::pin(async move { McpBinding::handle(&binding, request).await })
    }
}

fn rpc(status: u16, id: &Value, answer: Result<Value, RpcError>) -> Response<ResponseBody> {
    json_response(status, &response(id, answer))
}

fn rejected(rejection: Rejection) -> Response<ResponseBody> {
    let (status, error) = match rejection {
        Rejection::Method => (405, None),
        Rejection::Origin => (403, None),
        Rejection::MediaType => (415, None),
        Rejection::TooLarge => (413, Some((-32600, "The request body is too large."))),
        Rejection::NotUtf8 => (400, Some((-32700, "The request body is not UTF-8 JSON."))),
    };
    let mut answer = match error {
        Some((code, message)) => json_response(
            status,
            &response(&Value::Null, Err(RpcError::new(code, message))),
        ),
        None => empty_response(status),
    };
    answer
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if rejection == Rejection::Method {
        answer
            .headers_mut()
            .insert(header::ALLOW, HeaderValue::from_static("POST"));
    }
    answer
}
