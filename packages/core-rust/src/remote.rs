//! The parts that the remote surfaces share (spec/surfaces/README.md#remote-surfaces): the body types, the screening
//! of a request, the bounded read of a body, and a server that serves handlers by path prefix.

use std::convert::Infallible;
use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
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
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

pub type BoxError = Box<dyn std::error::Error + Send + Sync>;

pub type RequestBody = UnsyncBoxBody<Bytes, BoxError>;

pub type ResponseBody = UnsyncBoxBody<Bytes, Infallible>;

/// The time with nothing sent on a stream after which a surface sends a keepalive or a heartbeat.
pub const KEEPALIVE: Duration = Duration::from_millis(crate::facts_generated::KEEPALIVE_MS);

pub const DEFAULT_MAXIMUM_BYTES: usize = 1_048_576;

pub trait Handler: Send + Sync + 'static {
    fn handle(&self, request: Request<RequestBody>) -> BoxFuture<'static, Response<ResponseBody>>;
}

/// When a handler drops the body before its end, the rest of the body is read and discarded, so that the connection
/// ends only when the request is complete.
pub fn request_body<B>(request: Request<B>) -> Request<RequestBody>
where
    B: http_body::Body<Data = Bytes> + Send + 'static,
    B::Error: Into<BoxError>,
{
    request.map(|body| Discarded(Some(body.map_err(Into::into).boxed_unsync())).boxed_unsync())
}

struct Discarded(Option<RequestBody>);

impl http_body::Body for Discarded {
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        match self.0.as_mut() {
            Some(body) => Pin::new(body).poll_frame(context),
            None => Poll::Ready(None),
        }
    }

    fn is_end_stream(&self) -> bool {
        self.0.as_ref().is_none_or(http_body::Body::is_end_stream)
    }
}

impl Drop for Discarded {
    fn drop(&mut self) {
        if let Some(mut body) = self
            .0
            .take()
            .filter(|body| !http_body::Body::is_end_stream(body))
            && let Ok(runtime) = tokio::runtime::Handle::try_current()
        {
            runtime.spawn(async move { while let Some(Ok(_)) = body.frame().await {} });
        }
    }
}

/// The first rule of a remote surface that a request breaks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Rejection {
    Method,
    Origin,
    MediaType,
    TooLarge,
    NotUtf8,
}

pub(crate) struct Rules<'a> {
    pub(crate) methods: &'a [Method],
    pub(crate) allowed_origins: &'a [String],
    pub(crate) maximum_bytes: usize,
}

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

pub(crate) async fn read_request(
    request: Request<RequestBody>,
    rules: &Rules<'_>,
) -> Result<(http::request::Parts, String), Rejection> {
    if let Some(rejection) = screen(&request, rules) {
        return Err(rejection);
    }
    let (parts, mut body) = request.into_parts();
    let text = read_bounded(&mut body, rules.maximum_bytes).await?;
    Ok((parts, text))
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

pub(crate) fn header_text<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

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

pub(crate) fn empty_response(status: u16) -> Response<ResponseBody> {
    let mut response = Response::new(Empty::new().map_err(|never| match never {}).boxed_unsync());
    *response.status_mut() =
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    response
}

pub(crate) fn sse_response(stream: BoxStream<'static, String>) -> Response<ResponseBody> {
    let body =
        StreamBody::new(stream.map(|text| Ok::<_, Infallible>(Frame::data(Bytes::from(text)))));
    let mut response = Response::new(BodyExt::boxed_unsync(body));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(crate::facts_generated::SSE_MEDIA_TYPE),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

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
    /// A refusal with a status from 400 to 599.
    ///
    /// # Panics
    ///
    /// When `status` is not from 400 to 599, as `refuse` of the TypeScript cores throws.
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        assert!(
            (400..=599).contains(&status),
            "the status of a refusal is from 400 to 599, not {status}"
        );
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
                if name != header::CONTENT_TYPE {
                    response.headers_mut().append(name, value);
                }
            }
        }
        response
    }
}

/// Makes the context of one request from its head (the method, the URI and the headers), or refuses the request.
pub type RequestContext<C> =
    Arc<dyn Fn(&http::request::Parts) -> BoxFuture<'static, Result<Arc<C>, Refusal>> + Send + Sync>;

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
    running: Running,
}

impl Served {
    /// The base URL of the server, for example `http://127.0.0.1:40123`.
    pub fn url(&self) -> String {
        format!("http://{}", self.address)
    }

    pub async fn close(self) {
        self.running.close().await;
    }
}

/// A server that serves handlers on a Unix socket. `close` stops it and removes the socket file.
pub struct UnixServed {
    pub path: std::path::PathBuf,
    running: Running,
}

impl UnixServed {
    /// The base URL to give with the path of the socket, `http://localhost`. Each request uses it for its path and its
    /// `Host` header.
    pub fn url(&self) -> String {
        "http://localhost".to_owned()
    }

    pub async fn close(self) {
        self.running.close().await;
        let _ = std::fs::remove_file(&self.path);
    }
}

struct Running {
    stop: CancellationToken,
    task: tokio::task::JoinHandle<()>,
}

impl Running {
    async fn close(self) {
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
    Ok(Served {
        address,
        running: run(listener, routes),
    })
}

/// Serve handlers by path prefix on a new Unix socket at `path`. It fails when a file is at `path`. Give the client
/// the path and the base URL `http://localhost`. On a system that is not Unix, it fails with an error of kind
/// `Unsupported`.
pub async fn serve_unix(
    path: impl Into<std::path::PathBuf>,
    routes: Routes,
) -> std::io::Result<UnixServed> {
    let path = path.into();
    let running = run_unix(&path, routes)?;
    Ok(UnixServed { path, running })
}

#[cfg(unix)]
fn run_unix(path: &std::path::Path, routes: Routes) -> std::io::Result<Running> {
    Ok(run(tokio::net::UnixListener::bind(path)?, routes))
}

#[cfg(not(unix))]
fn run_unix(_path: &std::path::Path, _routes: Routes) -> std::io::Result<Running> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "Unix sockets are not available on this system.",
    ))
}

trait Listener: Send + 'static {
    type Stream: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Unpin + 'static;

    fn accept(&self) -> impl Future<Output = std::io::Result<Self::Stream>> + Send;
}

impl Listener for TcpListener {
    type Stream = tokio::net::TcpStream;

    async fn accept(&self) -> std::io::Result<Self::Stream> {
        let (stream, _) = TcpListener::accept(self).await?;
        // With Nagle's algorithm, the kernel holds a small message of a stream, such as an MCP notification, until
        // the client acknowledges the last one, which can take 40 ms.
        let _ = stream.set_nodelay(true);
        Ok(stream)
    }
}

#[cfg(unix)]
impl Listener for tokio::net::UnixListener {
    type Stream = tokio::net::UnixStream;

    async fn accept(&self) -> std::io::Result<Self::Stream> {
        tokio::net::UnixListener::accept(self)
            .await
            .map(|(stream, _)| stream)
    }
}

fn run(listener: impl Listener, routes: Routes) -> Running {
    let mut routes = routes;
    routes.sort_by_key(|(prefix, _)| std::cmp::Reverse(prefix.len()));
    let routes = Arc::new(routes);
    let stop = CancellationToken::new();
    let stopped = stop.clone();
    let connections = TaskTracker::new();
    let task = tokio::spawn(async move {
        loop {
            let accepted = tokio::select! {
                () = stopped.cancelled() => break,
                accepted = listener.accept() => accepted,
            };
            let Ok(stream) = accepted else { continue };
            connections.spawn(serve_connection(stream, routes.clone(), stopped.clone()));
        }
        drop(listener);
        connections.close();
        connections.wait().await;
    });
    Running { stop, task }
}

async fn serve_connection(
    stream: impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Unpin + 'static,
    routes: Arc<Routes>,
    stopped: CancellationToken,
) {
    let (opened, mut open_responses) = watch::channel(0_usize);
    let service = hyper::service::service_fn(move |request: Request<hyper::body::Incoming>| {
        let routes = routes.clone();
        opened.send_modify(|open| *open += 1);
        let opened = opened.clone();
        let complete = OnDrop(move || opened.send_modify(|open| *open -= 1));
        async move {
            let response = route(&routes, request_body(request)).await;
            Ok::<_, Infallible>(response.map(|body| until_dropped(body, complete)))
        }
    });
    let connection = hyper::server::conn::http1::Builder::new()
        .serve_connection(hyper_util::rt::TokioIo::new(stream), service);
    tokio::pin!(connection);
    let closed_with_no_open_response = async {
        stopped.cancelled().await;
        let _ = open_responses.wait_for(|open| *open == 0).await;
    };
    tokio::select! {
        _ = connection.as_mut() => return,
        () = closed_with_no_open_response => {}
    }
    connection.as_mut().graceful_shutdown();
    let _ = connection.await;
}

fn until_dropped(body: ResponseBody, guard: impl Send + 'static) -> ResponseBody {
    body.map_frame(move |frame| {
        let _ = &guard;
        frame
    })
    .boxed_unsync()
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

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use futures::future::BoxFuture;
    use http::{Request, Response};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;
    use tokio::sync::{mpsc, watch};

    use super::{Handler, RequestBody, ResponseBody, Served};

    async fn exchange(stream: &mut TcpStream) -> String {
        stream
            .write_all(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .await
            .expect("the request is sent");
        let mut answer = Vec::new();
        while !answer.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            let read = stream.read(&mut byte).await.expect("the answer is read");
            assert_eq!(read, 1, "the server closed the connection: {answer:?}");
            answer.push(byte[0]);
        }
        String::from_utf8(answer).expect("the head of the answer is text")
    }

    #[tokio::test(start_paused = true)]
    async fn serve_closes_no_idle_connection_and_sends_no_keep_alive_header() {
        let served = super::serve(
            "127.0.0.1:0".parse().expect("the address parses"),
            Vec::new(),
        )
        .await
        .expect("the server listens");
        let mut stream = TcpStream::connect(served.address)
            .await
            .expect("the client connects");
        let first = exchange(&mut stream).await;
        tokio::time::advance(Duration::from_secs(24 * 60 * 60)).await;
        let second = exchange(&mut stream).await;
        for answer in [first, second] {
            assert!(answer.starts_with("HTTP/1.1 404"), "{answer}");
            assert!(
                !answer.to_ascii_lowercase().contains("keep-alive"),
                "{answer}"
            );
        }
        served.close().await;
    }

    struct Held {
        received: mpsc::UnboundedSender<()>,
        released: watch::Receiver<bool>,
    }

    impl Handler for Held {
        fn handle(
            &self,
            _request: Request<RequestBody>,
        ) -> BoxFuture<'static, Response<ResponseBody>> {
            let _ = self.received.send(());
            let mut released = self.released.clone();
            Box::pin(async move {
                let _ = released.wait_for(|released| *released).await;
                super::empty_response(204)
            })
        }
    }

    struct HeldServer {
        served: Served,
        received: mpsc::UnboundedReceiver<()>,
        release: watch::Sender<bool>,
    }

    async fn held_server() -> HeldServer {
        let (received, receiver) = mpsc::unbounded_channel();
        let (release, released) = watch::channel(false);
        let served = super::serve(
            "127.0.0.1:0".parse().expect("the address parses"),
            vec![("/".into(), Arc::new(Held { received, released }))],
        )
        .await
        .expect("the server listens");
        HeldServer {
            served,
            received: receiver,
            release,
        }
    }

    async fn start_close(served: Served) -> impl Future<Output = ()> {
        let mut closed = Box::pin(served.close());
        assert!(
            futures::poll!(&mut closed).is_pending(),
            "close waits for the connection"
        );
        // On a runtime of one thread, `yield_now` lets the tasks of the server act on the close first.
        tokio::task::yield_now().await;
        closed
    }

    struct Client {
        stream: TcpStream,
        text: String,
    }

    #[derive(Debug, PartialEq)]
    struct Closed {
        answers: usize,
        error: Option<String>,
    }

    impl Client {
        async fn connect(served: &Served) -> Self {
            let stream = TcpStream::connect(served.address)
                .await
                .expect("the client connects");
            Client {
                stream,
                text: String::new(),
            }
        }

        async fn write(&mut self, data: &str) {
            self.stream
                .write_all(data.as_bytes())
                .await
                .expect("the client writes");
        }

        fn answers(&self) -> usize {
            self.text.matches("HTTP/1.1 204").count()
        }

        async fn read(&mut self) -> std::io::Result<usize> {
            let mut buffer = [0; 1024];
            let read = self.stream.read(&mut buffer).await?;
            self.text
                .push_str(&String::from_utf8_lossy(&buffer[..read]));
            Ok(read)
        }

        async fn until_answers(&mut self, count: usize) {
            while self.answers() < count {
                let read = self.read().await.expect("the client reads");
                assert_ne!(read, 0, "the server ended the connection: {}", self.text);
            }
        }

        fn ended(&self) -> bool {
            let mut buffer = [0; 1];
            !matches!(self.stream.try_read(&mut buffer), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
        }

        async fn closed(mut self) -> Closed {
            let error = loop {
                match self.read().await {
                    Ok(0) => break None,
                    Ok(_) => {}
                    Err(error) => break Some(error.to_string()),
                }
            };
            Closed {
                answers: self.answers(),
                error,
            }
        }
    }

    const GET: &str = "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";

    #[tokio::test]
    async fn close_ends_an_idle_connection() {
        let server = held_server().await;
        let _ = server.release.send(true);
        let mut client = Client::connect(&server.served).await;
        client.write(GET).await;
        client.until_answers(1).await;
        server.served.close().await;
        assert_eq!(
            client.closed().await,
            Closed {
                answers: 1,
                error: None
            }
        );
    }

    #[tokio::test]
    async fn close_ends_a_connection_after_the_response_that_runs_when_the_server_closes() {
        let mut server = held_server().await;
        let mut client = Client::connect(&server.served).await;
        client.write(GET).await;
        server.received.recv().await;
        let closed = start_close(server.served).await;
        let _ = server.release.send(true);
        closed.await;
        assert_eq!(
            client.closed().await,
            Closed {
                answers: 1,
                error: None
            }
        );
    }

    #[tokio::test]
    async fn close_ends_a_connection_after_the_end_of_a_request_body_that_still_arrives_when_the_response_is_complete()
     {
        let mut server = held_server().await;
        let mut client = Client::connect(&server.served).await;
        client
            .write("POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\n\r\na")
            .await;
        server.received.recv().await;
        let closed = start_close(server.served).await;
        let _ = server.release.send(true);
        client.until_answers(1).await;
        assert!(
            !client.ended(),
            "the server waits for the rest of the request"
        );
        client.write("b").await;
        closed.await;
        assert_eq!(
            client.closed().await,
            Closed {
                answers: 1,
                error: None
            }
        );
    }

    #[tokio::test]
    async fn close_ends_a_connection_after_the_answer_to_a_second_request_that_the_client_sent_before_the_first_answer()
     {
        let mut server = held_server().await;
        let mut client = Client::connect(&server.served).await;
        client.write(&format!("{GET}{GET}")).await;
        server.received.recv().await;
        let closed = start_close(server.served).await;
        let _ = server.release.send(true);
        closed.await;
        assert_eq!(
            client.closed().await,
            Closed {
                answers: 2,
                error: None
            }
        );
    }
}
