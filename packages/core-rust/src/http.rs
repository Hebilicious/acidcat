//! The HTTP binding (spec/bindings/http.md): JSON through HTTP, and events as server-sent events.

use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use futures::stream::StreamExt;
use http::{HeaderValue, Method, Request, Response, header};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::app::Application;
use crate::outcome::{CallFailure, Kind, Outcome};
use crate::remote::{
    Contexts, DEFAULT_MAXIMUM_BYTES, Handler, KEEPALIVE, OnDrop, Refusal, Rejection, RequestBody,
    ResponseBody, Rules, empty_response, header_text, json_response, read_request, sse_message,
    sse_response,
};
use crate::session::{DEFAULT_BUFFER_LIMIT, Session, SubscribeOptions};

/// The settings of the HTTP binding.
#[derive(Clone, Debug)]
pub struct HttpOptions {
    /// The origins that can call the API. A request with no `Origin` header is accepted.
    pub allowed_origins: Vec<String>,
    /// The target that the API serves. The default is `api`.
    pub target: String,
    /// The path before `/capabilities`, for example `/api`. The default is empty.
    pub base: String,
    /// Serve `GET {base}/catalog`. The default is `true`.
    pub serve_catalog: bool,
    /// The maximum size of a request body, in bytes. The default is 1 MiB.
    pub maximum_bytes: usize,
    /// The time with nothing sent on a stream after which the binding sends a comment line. The default is 15 seconds.
    pub keepalive: Duration,
    /// The number of occurrences that each subscription keeps for a client that reads slowly. The default is 256.
    pub buffer_limit: usize,
}

impl Default for HttpOptions {
    fn default() -> Self {
        HttpOptions {
            allowed_origins: Vec::new(),
            target: "api".into(),
            base: String::new(),
            serve_catalog: true,
            maximum_bytes: DEFAULT_MAXIMUM_BYTES,
            keepalive: KEEPALIVE,
            buffer_limit: DEFAULT_BUFFER_LIMIT,
        }
    }
}

/// The HTTP binding of an application. Each request has its own session.
pub struct HttpBinding<C> {
    app: Arc<Application<C>>,
    context: Contexts<C>,
    options: Arc<HttpOptions>,
}

impl<C> Clone for HttpBinding<C> {
    fn clone(&self) -> Self {
        HttpBinding {
            app: self.app.clone(),
            context: self.context.clone(),
            options: self.options.clone(),
        }
    }
}

impl<C: Send + Sync + 'static> HttpBinding<C> {
    /// A binding whose requests share one context.
    pub fn new(app: Arc<Application<C>>, context: Arc<C>, options: HttpOptions) -> Self {
        HttpBinding {
            app,
            context: Contexts::Shared(context),
            options: Arc::new(options),
        }
    }

    /// A binding that makes a context for each request that passes the screening, from the head of the request: for
    /// example the caller, from a token in a header. A [`Refusal`] answers the request instead. The context is
    /// dropped when the session of the request ends: after the answer, or after the stream of a subscription.
    pub fn with_request_context<Make, Made>(
        app: Arc<Application<C>>,
        make: Make,
        options: HttpOptions,
    ) -> Self
    where
        Make: Fn(&http::request::Parts) -> Made + Send + Sync + 'static,
        Made: std::future::Future<Output = Result<C, Refusal>> + Send + 'static,
    {
        HttpBinding {
            app,
            context: Contexts::per_request(make),
            options: Arc::new(options),
        }
    }

    /// Answer one request.
    pub async fn handle(&self, request: Request<RequestBody>) -> Response<ResponseBody> {
        let options = &self.options;
        let rules = Rules {
            methods: &[Method::GET, Method::POST],
            allowed_origins: &options.allowed_origins,
            maximum_bytes: options.maximum_bytes,
        };
        let (parts, text) = match read_request(request, &rules).await {
            Ok(read) => read,
            Err(rejection) => return rejected(rejection),
        };
        let path = parts
            .uri
            .path()
            .strip_prefix(options.base.as_str())
            .unwrap_or("")
            .to_owned();
        let context = match self.context.open(&parts).await {
            Ok(context) => context,
            Err(refusal) => return refusal.response(),
        };
        let session =
            Session::with_buffer_limit(&self.app, &options.target, context, options.buffer_limit);
        // The session closes when the answer ends, or when a stream of a subscription ends.
        let close = session.clone();
        let guard = OnDrop(move || close.close());

        if parts.method == Method::GET {
            return match path.as_str() {
                "/capabilities" => {
                    let entries: Vec<Value> = session
                        .capability_ids()
                        .iter()
                        .map(|id| {
                            let mut entry = serde_json::Map::new();
                            entry.insert("id".into(), json!(id));
                            entry.extend(
                                session
                                    .availability(id)
                                    .map(|availability| availability.members())
                                    .unwrap_or_default(),
                            );
                            Value::Object(entry)
                        })
                        .collect();
                    json_response(200, &Value::Array(entries))
                }
                "/events" => json_response(
                    200,
                    &Value::Array(
                        session
                            .event_ids()
                            .iter()
                            .map(|id| json!({ "id": id }))
                            .collect(),
                    ),
                ),
                "/catalog" if options.serve_catalog => json_response(200, session.view()),
                _ => no_route(),
            };
        }
        let (kind, encoded) = if let Some(id) = path.strip_prefix("/capabilities/") {
            (Route::Capability, id)
        } else if let Some(id) = path.strip_prefix("/events/") {
            (Route::Event, id)
        } else {
            return no_route();
        };
        // An id with a malformed escape names no capability and no event.
        let Some(id) = percent_decode(encoded) else {
            return no_route();
        };
        let input: Value = if text.is_empty() {
            json!({})
        } else {
            match serde_json::from_str(&text) {
                Ok(input) => input,
                Err(_) => return failure_response(&not_json(&session, kind, &id)),
            }
        };
        match kind {
            Route::Capability => {
                // When the client closes the request, the server drops this future, and the call is cancelled.
                let outcome = session.invoke(&id, input, &CancellationToken::new()).await;
                match outcome {
                    Outcome::CallFailure(failure) => failure_response(&failure),
                    outcome => json_response(200, &outcome.to_json()),
                }
            }
            Route::Event => {
                let max_age_ms = parts.uri.query().and_then(|query| {
                    query
                        .split('&')
                        .find_map(|pair| pair.strip_prefix("maxAgeMs="))
                        .map(|text| {
                            if !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()) {
                                text.parse::<f64>().unwrap_or(f64::NAN)
                            } else {
                                f64::NAN
                            }
                        })
                });
                let cursor = header_text(&parts.headers, "last-event-id").map(str::to_owned);
                let mut occurrences = match session.subscribe(
                    &id,
                    input,
                    SubscribeOptions {
                        cursor,
                        max_age_ms,
                        cancel: CancellationToken::new(),
                    },
                ) {
                    Ok(occurrences) => occurrences,
                    Err(failure) => return failure_response(&failure),
                };
                let keepalive = options.keepalive;
                let stream = async_stream(move |sender| async move {
                    let _guard = guard;
                    loop {
                        let next = match tokio::time::timeout(keepalive, occurrences.next()).await {
                            Err(_) => {
                                if sender.send(":\n\n".to_owned()).await.is_err() {
                                    return;
                                }
                                continue;
                            }
                            Ok(next) => next,
                        };
                        let message = match next {
                            None => sse_message(Some("complete"), None, ""),
                            Some(Err(failure)) => {
                                sse_message(Some("error"), None, &failure.to_json().to_string())
                            }
                            Some(Ok(occurrence)) => sse_message(
                                Some("next"),
                                occurrence.cursor.as_deref(),
                                &occurrence.to_json().to_string(),
                            ),
                        };
                        let last = !message.starts_with("event: next");
                        if sender.send(message).await.is_err() || last {
                            return;
                        }
                    }
                });
                sse_response(stream)
            }
        }
    }
}

impl<C: Send + Sync + 'static> Handler for HttpBinding<C> {
    fn handle(&self, request: Request<RequestBody>) -> BoxFuture<'static, Response<ResponseBody>> {
        let binding = self.clone();
        Box::pin(async move { HttpBinding::handle(&binding, request).await })
    }
}

/// A stream of messages that a task writes. When the client drops the stream, the task stops at its next send, and
/// the server drops the task.
pub(crate) fn async_stream<F, Fut>(produce: F) -> futures::stream::BoxStream<'static, String>
where
    F: FnOnce(tokio::sync::mpsc::Sender<String>) -> Fut,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let (sender, receiver) = tokio::sync::mpsc::channel(1);
    let task = tokio::spawn(produce(sender));
    let abort = OnDrop(move || task.abort());
    futures::stream::unfold((receiver, abort), |(mut receiver, abort)| async move {
        receiver
            .recv()
            .await
            .map(|message| (message, (receiver, abort)))
    })
    .boxed()
}

#[derive(Clone, Copy)]
enum Route {
    Capability,
    Event,
}

/// The call failure of a request whose body is not JSON. The kinds before `invalid-input` apply first.
fn not_json<C: Send + Sync + 'static>(session: &Session<C>, route: Route, id: &str) -> CallFailure {
    match route {
        Route::Event if !session.has_event(id) => {
            CallFailure::new(Kind::UnknownCapability, format!("There is no event {id}."))
        }
        Route::Capability => match session.availability(id) {
            None => CallFailure::new(
                Kind::UnknownCapability,
                format!("There is no capability {id}."),
            ),
            Some(crate::outcome::Availability::Unavailable { reason }) => {
                CallFailure::new(Kind::Unavailable, reason)
            }
            Some(_) => CallFailure::new(Kind::InvalidInput, "The request body is not JSON."),
        },
        Route::Event => CallFailure::new(Kind::InvalidInput, "The request body is not JSON."),
    }
}

/// The status of a call failure (spec/bindings/http.md#requests).
fn status_of(kind: Kind) -> u16 {
    match kind {
        Kind::UnknownCapability => 404,
        Kind::InvalidInput => 422,
        Kind::Unavailable => 503,
        Kind::Cancelled => 409,
        Kind::Internal => 500,
    }
}

fn failure_response(failure: &CallFailure) -> Response<ResponseBody> {
    json_response(status_of(failure.kind), &failure.to_json())
}

fn no_route() -> Response<ResponseBody> {
    failure_response(&CallFailure::new(
        Kind::UnknownCapability,
        "There is no such route.",
    ))
}

fn rejected(rejection: Rejection) -> Response<ResponseBody> {
    let status = match rejection {
        Rejection::Method => 405,
        Rejection::Origin => 403,
        Rejection::MediaType => 415,
        Rejection::TooLarge => 413,
        Rejection::NotUtf8 => 400,
    };
    let mut response = empty_response(status);
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if rejection == Rejection::Method {
        response
            .headers_mut()
            .insert(header::ALLOW, HeaderValue::from_static("GET, POST"));
    }
    response
}

/// Decode the escapes of a path segment, or `None` when an escape is malformed or the text is not UTF-8.
fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = std::str::from_utf8(bytes.get(index + 1..index + 3)?).ok()?;
            decoded.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}
