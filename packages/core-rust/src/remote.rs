//! The parts that the remote bindings share (spec/bindings/README.md#remote-bindings): the body types, the screening
//! of a request, the bounded read of a body, and a server that serves handlers by path prefix.

use std::convert::Infallible;
use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use futures::future::BoxFuture;
use futures::stream::{BoxStream, StreamExt};
use http::{HeaderMap, HeaderValue, Method, Request, Response, StatusCode, header};
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt, Empty, Full, StreamBody};
use hyper::body::Frame;
use serde_json::Value;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

/// An error of a body.
pub type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// The body of a request that a binding reads.
pub type RequestBody = UnsyncBoxBody<Bytes, BoxError>;

/// The body of a response that a binding gives.
pub type ResponseBody = UnsyncBoxBody<Bytes, Infallible>;

/// The time with nothing sent on a stream after which a binding sends a keepalive or a heartbeat.
pub const KEEPALIVE: Duration = Duration::from_secs(15);

/// The default limit of a request body: 1 MiB.
pub const DEFAULT_MAXIMUM_BYTES: usize = 1_048_576;

/// A web request handler, as the bindings give it. [`serve`] serves handlers.
pub trait Handler: Send + Sync + 'static {
    fn handle(&self, request: Request<RequestBody>) -> BoxFuture<'static, Response<ResponseBody>>;
}

/// Turn the body of a hyper request into a [`RequestBody`].
pub fn request_body<B>(request: Request<B>) -> Request<RequestBody>
where
    B: http_body::Body<Data = Bytes> + Send + 'static,
    B::Error: Into<BoxError>,
{
    request.map(|body| body.map_err(Into::into).boxed_unsync())
}

/// The first rule of a remote binding that a request breaks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Rejection {
    Method,
    Origin,
    MediaType,
    TooLarge,
    NotUtf8,
}

/// The rules of a binding for the screening of a request.
pub(crate) struct Rules<'a> {
    pub(crate) methods: &'a [Method],
    pub(crate) allowed_origins: &'a [String],
    pub(crate) maximum_bytes: usize,
}

/// The first rule that a request breaks before its body is read: method, origin, media type, declared length.
pub(crate) fn screen<B>(request: &Request<B>, rules: &Rules<'_>) -> Option<Rejection> {
    if !rules.methods.contains(request.method()) {
        return Some(Rejection::Method);
    }
    if let Some(origin) = request.headers().get(header::ORIGIN)
        && !rules
            .allowed_origins
            .iter()
            .any(|allowed| allowed.as_bytes() == origin.as_bytes())
    {
        return Some(Rejection::Origin);
    }
    if request.method() == Method::GET || request.method() == Method::HEAD {
        return None;
    }
    let media_type = header_text(request.headers(), header::CONTENT_TYPE.as_str())
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if media_type != "application/json" {
        return Some(Rejection::MediaType);
    }
    let declared = header_text(request.headers(), header::CONTENT_LENGTH.as_str())
        .and_then(|text| text.parse::<u64>().ok());
    if declared.is_some_and(|length| length > rules.maximum_bytes as u64) {
        return Some(Rejection::TooLarge);
    }
    None
}

/// Screen a request, and read its body as UTF-8 text. Count the bytes as they arrive, and stop at the limit.
///
/// Before a rejection, the server discards the rest of the body, up to a second limit, so that the client reads the
/// answer and does not see a connection that closes while it sends.
pub(crate) async fn read_request(
    request: Request<RequestBody>,
    rules: &Rules<'_>,
) -> Result<(http::request::Parts, String), Rejection> {
    let rejection = screen(&request, rules);
    let (parts, mut body) = request.into_parts();
    let read = match rejection {
        Some(rejection) => Err(rejection),
        None => read_bounded(&mut body, rules.maximum_bytes).await,
    };
    match read {
        Ok(text) => Ok((parts, text)),
        Err(rejection) => {
            discard(
                &mut body,
                rules.maximum_bytes.saturating_add(DEFAULT_MAXIMUM_BYTES),
            )
            .await;
            Err(rejection)
        }
    }
}

async fn read_bounded(body: &mut RequestBody, maximum_bytes: usize) -> Result<String, Rejection> {
    let mut bytes = Vec::new();
    while let Some(frame) = body.frame().await {
        let Ok(frame) = frame else {
            return Err(Rejection::NotUtf8);
        };
        if let Ok(data) = frame.into_data() {
            if bytes.len() + data.len() > maximum_bytes {
                return Err(Rejection::TooLarge);
            }
            bytes.extend_from_slice(&data);
        }
    }
    String::from_utf8(bytes).map_err(|_| Rejection::NotUtf8)
}

/// Read and drop the rest of a body, up to `limit` bytes and for at most one second.
async fn discard(body: &mut RequestBody, limit: usize) {
    let drain = async {
        let mut read = 0;
        while read <= limit {
            match body.frame().await {
                Some(Ok(frame)) => read += frame.data_ref().map_or(0, Bytes::len),
                _ => return,
            }
        }
    };
    let _ = tokio::time::timeout(Duration::from_secs(1), drain).await;
}

/// The text of a header, if the request has it and it is text.
pub(crate) fn header_text<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

/// A response with a JSON body.
pub(crate) fn json_response(status: u16, body: &Value) -> Response<ResponseBody> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(
            Full::new(Bytes::from(body.to_string()))
                .map_err(|never| match never {})
                .boxed_unsync(),
        )
        .unwrap_or_else(|_| empty_response(500))
}

/// A response with no body.
pub(crate) fn empty_response(status: u16) -> Response<ResponseBody> {
    let mut response = Response::new(Empty::new().map_err(|never| match never {}).boxed_unsync());
    *response.status_mut() =
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    response
}

/// A stream of server-sent events: status 200, `text/event-stream` and `Cache-Control: no-store`. When the client
/// closes the response, the server drops the stream.
pub(crate) fn sse_response(stream: BoxStream<'static, String>) -> Response<ResponseBody> {
    let body =
        StreamBody::new(stream.map(|text| Ok::<_, Infallible>(Frame::data(Bytes::from(text)))));
    let mut response = Response::new(BodyExt::boxed_unsync(body));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// One message of a stream of server-sent events, with the blank line that ends it.
pub(crate) fn sse_message(event: Option<&str>, id: Option<&str>, data: &str) -> String {
    let mut lines = Vec::new();
    if let Some(event) = event {
        lines.push(format!("event: {event}"));
    }
    if let Some(id) = id {
        lines.push(format!("id: {id}"));
    }
    for line in data.split('\n') {
        lines.push(if line.is_empty() {
            "data:".to_owned()
        } else {
            format!("data: {line}")
        });
    }
    format!("{}\n\n", lines.join("\n"))
}

/// Calls a function when it is dropped: when a response or a stream ends in any way.
pub(crate) struct OnDrop<F: FnMut()>(pub(crate) F);

impl<F: FnMut()> Drop for OnDrop<F> {
    fn drop(&mut self) {
        (self.0)();
    }
}

/// The answer that refuses a request, for example `401` when the request has no valid token.
#[derive(Clone, Debug)]
pub struct Refusal {
    pub status: u16,
    /// The text of the answer, in its JSON body `{ "message" }`. Show no internal data.
    pub message: String,
    pub headers: Vec<(String, String)>,
}

impl Refusal {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Refusal {
            status,
            message: message.into(),
            headers: Vec::new(),
        }
    }

    /// Add a header to the answer, for example `WWW-Authenticate`.
    pub fn header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    pub(crate) fn response(&self) -> Response<ResponseBody> {
        let mut response =
            json_response(self.status, &serde_json::json!({ "message": self.message }));
        for (name, value) in &self.headers {
            if let (Ok(name), Ok(value)) = (
                http::HeaderName::try_from(name.as_str()),
                http::HeaderValue::try_from(value.as_str()),
            ) {
                response.headers_mut().append(name, value);
            }
        }
        response
    }
}

/// Makes the context of one request from its head (the method, the URI and the headers), or refuses the request.
pub type RequestContext<C> =
    Arc<dyn Fn(&http::request::Parts) -> BoxFuture<'static, Result<Arc<C>, Refusal>> + Send + Sync>;

/// The context of the requests of a remote binding: one context for all requests, or one for each request.
pub(crate) enum Contexts<C> {
    Shared(Arc<C>),
    PerRequest(RequestContext<C>),
}

impl<C> Clone for Contexts<C> {
    fn clone(&self) -> Self {
        match self {
            Contexts::Shared(context) => Contexts::Shared(context.clone()),
            Contexts::PerRequest(make) => Contexts::PerRequest(make.clone()),
        }
    }
}

impl<C: Send + Sync + 'static> Contexts<C> {
    pub(crate) fn per_request<Make, Made>(make: Make) -> Self
    where
        Make: Fn(&http::request::Parts) -> Made + Send + Sync + 'static,
        Made: std::future::Future<Output = Result<C, Refusal>> + Send + 'static,
    {
        Contexts::PerRequest(Arc::new(move |parts| {
            let made = make(parts);
            Box::pin(async move { made.await.map(Arc::new) })
        }))
    }

    /// The context of one request that passed the screening.
    pub(crate) async fn open(&self, parts: &http::request::Parts) -> Result<Arc<C>, Refusal> {
        match self {
            Contexts::Shared(context) => Ok(context.clone()),
            Contexts::PerRequest(make) => make(parts).await,
        }
    }
}

/// A server that serves handlers. `close` stops it.
pub struct Served {
    /// The address of the server, for example `127.0.0.1:40123`.
    pub address: SocketAddr,
    stop: CancellationToken,
    task: tokio::task::JoinHandle<()>,
}

impl Served {
    /// The base URL of the server, for example `http://127.0.0.1:40123`.
    pub fn url(&self) -> String {
        format!("http://{}", self.address)
    }

    /// Stop the server.
    pub async fn close(self) {
        self.stop.cancel();
        let _ = self.task.await;
    }
}

/// Handlers by path prefix, for example `[("/mcp", mcp), ("/api", http)]`. The longest prefix that matches gets the
/// request.
pub type Routes = Vec<(String, Arc<dyn Handler>)>;

/// Serve handlers by path prefix on an address, for example `127.0.0.1:0` for a free port.
pub async fn serve(address: SocketAddr, routes: Routes) -> std::io::Result<Served> {
    let listener = TcpListener::bind(address).await?;
    let address = listener.local_addr()?;
    let mut routes = routes;
    routes.sort_by_key(|(prefix, _)| std::cmp::Reverse(prefix.len()));
    let routes = Arc::new(routes);
    let stop = CancellationToken::new();
    let stopped = stop.clone();
    let task = tokio::spawn(async move {
        loop {
            let accepted = tokio::select! {
                () = stopped.cancelled() => return,
                accepted = listener.accept() => accepted,
            };
            let Ok((stream, _)) = accepted else { continue };
            let routes = routes.clone();
            let stopped = stopped.clone();
            tokio::spawn(async move {
                let service = hyper::service::service_fn(
                    move |request: Request<hyper::body::Incoming>| {
                        let routes = routes.clone();
                        async move { Ok::<_, Infallible>(route(&routes, request_body(request)).await) }
                    },
                );
                let connection = hyper::server::conn::http1::Builder::new()
                    .serve_connection(hyper_util::rt::TokioIo::new(stream), service);
                tokio::pin!(connection);
                tokio::select! {
                    _ = connection.as_mut() => {}
                    () = stopped.cancelled() => {}
                }
            });
        }
    });
    Ok(Served {
        address,
        stop,
        task,
    })
}

fn route(
    routes: &Routes,
    request: Request<RequestBody>,
) -> Pin<Box<dyn Future<Output = Response<ResponseBody>> + Send>> {
    let path = request.uri().path().to_owned();
    let found = routes.iter().find(|(prefix, _)| {
        prefix == "/" || path == *prefix || path.starts_with(&format!("{prefix}/"))
    });
    match found {
        Some((_, handler)) => handler.handle(request),
        None => Box::pin(async { empty_response(404) }),
    }
}
