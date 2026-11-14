//! A client of the HTTP binding (spec/bindings/http.md). The command line uses it to call the capabilities and follow
//! the events of an application that runs in another process or on another machine.

use std::collections::VecDeque;
use std::sync::Arc;

use bytes::Bytes;
use futures::stream::{BoxStream, StreamExt};
use http::{HeaderName, HeaderValue, Method, Request, Uri, header};
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use serde_json::Value;

use crate::outcome::{Availability, CallFailure, Kind, Outcome};
use crate::subscription::Occurrence;

/// The largest answer that the client reads, in bytes.
const MAXIMUM_ANSWER: usize = 64 * 1024 * 1024;

/// A client of an HTTP binding at a base URL, for example `http://pi.local:8080/api`. Clones share the settings.
#[derive(Clone)]
pub struct HttpClient {
    base: String,
    headers: Vec<(HeaderName, HeaderValue)>,
    trusted_certificates: Vec<String>,
    tls: Arc<rustls::ClientConfig>,
}

impl std::fmt::Debug for HttpClient {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The headers can hold a token, so they are not shown.
        formatter
            .debug_struct("HttpClient")
            .field("base", &self.base)
            .finish_non_exhaustive()
    }
}

impl HttpClient {
    /// A client of the HTTP binding at `base`, an `http` or `https` URL. The error tells what is wrong with the URL.
    pub fn new(base: &str) -> Result<Self, String> {
        let base = base.trim_end_matches('/').to_owned();
        // A user name or a password is a credential: it must not reach an error message or a header. Give a token in
        // a header instead. A query or a fragment cannot come before the paths of the binding.
        if base
            .split_once("://")
            .map_or(base.as_str(), |(_, rest)| rest)
            .split('/')
            .next()
            .is_some_and(|authority| authority.contains('@'))
        {
            return Err(
                "The URL has a user name or a password. Give a token in a header instead.".into(),
            );
        }
        if base.contains(['?', '#']) {
            return Err(format!("{base} has a query or a fragment."));
        }
        let uri: Uri = base.parse().map_err(|_| format!("{base} is not a URL."))?;
        if !matches!(uri.scheme_str(), Some("http" | "https"))
            || uri.host().is_none_or(str::is_empty)
        {
            return Err(format!("{base} is not an http or https URL."));
        }
        Ok(HttpClient {
            base,
            headers: Vec::new(),
            trusted_certificates: Vec::new(),
            tls: Arc::new(crate::client::tls_config(&[])),
        })
    }

    /// Send a header with each request, for example `Authorization`. The error tells which part is not valid.
    pub fn header(mut self, name: &str, value: &str) -> Result<Self, String> {
        let name =
            HeaderName::try_from(name).map_err(|_| format!("{name} is not a header name."))?;
        let mut value = HeaderValue::try_from(value)
            .map_err(|_| format!("The value of the header {name} is not valid."))?;
        value.set_sensitive(true);
        self.headers.push((name, value));
        Ok(self)
    }

    /// Trust a certificate in PEM form, also a self-signed one, for an `https` URL.
    pub fn trust_certificate(mut self, pem: impl Into<String>) -> Self {
        self.trusted_certificates.push(pem.into());
        self.tls = Arc::new(crate::client::tls_config(&self.trusted_certificates));
        self
    }

    /// The base URL.
    pub fn base(&self) -> &str {
        &self.base
    }

    /// The capabilities of the view of the server, with their availability: `GET {base}/capabilities`.
    pub async fn capabilities(&self) -> Result<Vec<(String, Availability)>, CallFailure> {
        let answer = self.send(Method::GET, "/capabilities", None, None).await?;
        let (status, body) = read(answer).await?;
        if status != 200 {
            return Err(call_failure(&body));
        }
        // Each item has a string `id` and a boolean `available`, and a string `reason` when it is unavailable. Any other
        // answer is not an answer of the HTTP binding.
        let items = body.as_array().ok_or_else(not_an_answer)?;
        items
            .iter()
            .map(|item| {
                let id = item.get("id").and_then(Value::as_str);
                let available = item.get("available").and_then(Value::as_bool);
                let reason = item.get("reason").and_then(Value::as_str);
                match (id, available, reason) {
                    (Some(id), Some(true), _) => Ok((id.to_owned(), Availability::Available)),
                    (Some(id), Some(false), Some(reason)) => {
                        Ok((id.to_owned(), Availability::unavailable(reason)))
                    }
                    _ => Err(not_an_answer()),
                }
            })
            .collect()
    }

    /// Call a capability: `POST {base}/capabilities/{id}`. Drop the future to cancel the call: the client closes the
    /// request, and the server cancels the call.
    pub async fn invoke(&self, id: &str, input: &Value) -> Outcome {
        let answer = match self
            .send(
                Method::POST,
                &format!("/capabilities/{}", path_segment(id)),
                Some(input.to_string()),
                None,
            )
            .await
        {
            Ok(answer) => answer,
            Err(failure) => return Outcome::CallFailure(failure),
        };
        let (status, body) = match read(answer).await {
            Ok(read) => read,
            Err(failure) => return Outcome::CallFailure(failure),
        };
        if status != 200 {
            return Outcome::CallFailure(call_failure(&body));
        }
        match (body.get("ok"), body.get("value"), body.get("error")) {
            (Some(Value::Bool(true)), Some(value), _) => Outcome::Value(value.clone()),
            (Some(Value::Bool(false)), _, Some(error)) => Outcome::Failure(error.clone()),
            _ => Outcome::CallFailure(not_an_answer()),
        }
    }

    /// Subscribe to an event: `POST {base}/events/{id}`. The result is the occurrences, then a call failure if the
    /// subscription ends with one, or the call failure before the first occurrence. Drop the stream to cancel the
    /// subscription.
    pub async fn subscribe(
        &self,
        id: &str,
        input: &Value,
        cursor: Option<&str>,
        max_age_ms: Option<u64>,
    ) -> Result<BoxStream<'static, Result<Occurrence, CallFailure>>, CallFailure> {
        let path = match max_age_ms {
            Some(age) => format!("/events/{}?maxAgeMs={age}", path_segment(id)),
            None => format!("/events/{}", path_segment(id)),
        };
        let answer = self
            .send(Method::POST, &path, Some(input.to_string()), cursor)
            .await?;
        if answer.status() != 200 {
            let (_, body) = read(answer).await?;
            return Err(call_failure(&body));
        }
        let media_type = answer
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        if !media_type.starts_with("text/event-stream") {
            return Err(not_an_answer());
        }
        Ok(server_sent_events(answer.into_body()))
    }

    async fn send(
        &self,
        method: Method,
        path: &str,
        body: Option<String>,
        last_event_id: Option<&str>,
    ) -> Result<http::Response<Incoming>, CallFailure> {
        let unreachable = || {
            CallFailure::new(
                Kind::Unavailable,
                format!("The server at {} does not answer.", self.base),
            )
        };
        let url: Uri = format!("{}{path}", self.base)
            .parse()
            .map_err(|_| CallFailure::new(Kind::InvalidInput, format!("{path} is not a path.")))?;
        let mut sender = crate::client::connect(&url, &self.tls, &|_| true)
            .await
            .map_err(|_| unreachable())?;
        let mut request = Request::builder()
            .method(method)
            .uri(url.path_and_query().map_or("/", |path| path.as_str()))
            .header(
                header::HOST,
                url.authority().map_or("", |authority| authority.as_str()),
            )
            .header(header::ACCEPT, "application/json, text/event-stream");
        if body.is_some() {
            request = request.header(header::CONTENT_TYPE, "application/json");
        }
        if let Some(cursor) = last_event_id {
            request = request.header("Last-Event-ID", cursor);
        }
        for (name, value) in &self.headers {
            request = request.header(name, value);
        }
        let request = request
            .body(Full::new(Bytes::from(body.unwrap_or_default())))
            .map_err(|_| CallFailure::new(Kind::InvalidInput, "The request is not valid."))?;
        sender
            .send_request(request)
            .await
            .map_err(|_| unreachable())
    }
}

/// An id as one segment of a path: each byte that is not unreserved (RFC 3986) is percent-encoded.
fn path_segment(id: &str) -> String {
    id.bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

/// The status and the JSON body of an answer.
async fn read(answer: http::Response<Incoming>) -> Result<(u16, Value), CallFailure> {
    let status = answer.status().as_u16();
    let mut body = answer.into_body();
    let mut bytes = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|_| broken())?;
        if let Ok(data) = frame.into_data() {
            if bytes.len() + data.len() > MAXIMUM_ANSWER {
                return Err(not_an_answer());
            }
            bytes.extend_from_slice(&data);
        }
    }
    let json = serde_json::from_slice(&bytes).map_err(|_| not_an_answer())?;
    Ok((status, json))
}

/// The call failure of an answer with a status that is not 200.
fn call_failure(body: &Value) -> CallFailure {
    serde_json::from_value(body.clone()).unwrap_or_else(|_| not_an_answer())
}

fn not_an_answer() -> CallFailure {
    CallFailure::new(
        Kind::Internal,
        "The server gave an answer that the HTTP binding does not give.",
    )
}

fn broken() -> CallFailure {
    CallFailure::new(Kind::Internal, "The connection to the server broke.")
}

/// The state of a stream of server-sent events.
struct Reader {
    body: Incoming,
    buffer: Vec<u8>,
    /// The messages that the reader has, and not yet given.
    ready: VecDeque<Result<Occurrence, CallFailure>>,
    event: String,
    data: Vec<String>,
    /// The stream sent `complete` or `error`, or broke.
    ended: bool,
}

impl Reader {
    /// Read the complete lines in the buffer.
    fn lines(&mut self) {
        // A line ends with CR LF, LF or CR. A CR at the end of the buffer waits for the next bytes, which can be its LF.
        while let Some(end) = self
            .buffer
            .iter()
            .position(|byte| *byte == b'\n' || *byte == b'\r')
        {
            let terminator = if self.buffer[end] == b'\r' {
                match self.buffer.get(end + 1) {
                    None => return,
                    Some(b'\n') => 2,
                    Some(_) => 1,
                }
            } else {
                1
            };
            let line: Vec<u8> = self.buffer.drain(..end + terminator).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim_end_matches(['\n', '\r']);
            if line.is_empty() {
                self.dispatch();
            } else if line.starts_with(':') {
                // A comment line keeps the connection open.
            } else {
                let (field, value) = line.split_once(':').unwrap_or((line, ""));
                let value = value.strip_prefix(' ').unwrap_or(value);
                match field {
                    "event" => self.event = value.to_owned(),
                    "data" => self.data.push(value.to_owned()),
                    _ => {}
                }
            }
            if self.ended {
                return;
            }
        }
    }

    /// Give the message that a blank line ends.
    fn dispatch(&mut self) {
        let event = std::mem::take(&mut self.event);
        let data = std::mem::take(&mut self.data).join("\n");
        match event.as_str() {
            "next" => self
                .ready
                .push_back(serde_json::from_str::<Occurrence>(&data).map_err(|_| not_an_answer())),
            "complete" => self.ended = true,
            "error" => {
                let failure = serde_json::from_str::<Value>(&data)
                    .map(|body| call_failure(&body))
                    .unwrap_or_else(|_| not_an_answer());
                self.ready.push_back(Err(failure));
                self.ended = true;
            }
            _ => {}
        }
    }
}

/// The occurrences of a stream of server-sent events, as the HTTP binding sends them.
fn server_sent_events(body: Incoming) -> BoxStream<'static, Result<Occurrence, CallFailure>> {
    let reader = Reader {
        body,
        buffer: Vec::new(),
        ready: VecDeque::new(),
        event: String::new(),
        data: Vec::new(),
        ended: false,
    };
    futures::stream::unfold(reader, |mut reader| async move {
        loop {
            if let Some(item) = reader.ready.pop_front() {
                return Some((item, reader));
            }
            if reader.ended {
                return None;
            }
            match reader.body.frame().await {
                Some(Ok(frame)) => {
                    if let Ok(data) = frame.into_data() {
                        reader.buffer.extend_from_slice(&data);
                        reader.lines();
                    }
                }
                // The body ended. A CR at its end ends a line. Then a stream that sent no `complete` broke.
                _ if reader.buffer.last() == Some(&b'\r') => {
                    reader.buffer.push(b'\n');
                    reader.lines();
                    if !reader.ended {
                        reader.ready.push_back(Err(broken()));
                        reader.ended = true;
                    }
                }
                _ => {
                    reader.ready.push_back(Err(broken()));
                    reader.ended = true;
                }
            }
        }
    })
    .boxed()
}

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    /// A server that answers each request on one connection with `answer`, then closes it. The result is its base URL.
    async fn server(answer: &'static str) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let mut request = [0; 4096];
                let _ = stream.read(&mut request).await;
                let _ = stream.write_all(answer.as_bytes()).await;
            }
        });
        format!("http://{address}/cli")
    }

    fn json_answer(body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    #[test]
    fn a_base_url_with_credentials_a_query_or_a_fragment_is_refused_without_its_credentials() {
        let error = HttpClient::new("http://user:secret-token@host/cli").unwrap_err();
        assert!(!error.contains("secret-token"), "{error}");
        assert!(HttpClient::new("http://host/cli?k=v").is_err());
        assert!(HttpClient::new("http://host/cli#top").is_err());
        assert!(HttpClient::new("ftp://host/cli").is_err());
        assert!(HttpClient::new("http://host/cli/").is_ok());
    }

    #[test]
    fn an_id_is_one_percent_encoded_segment_of_the_path() {
        assert_eq!(path_segment("aircon.power.set"), "aircon.power.set");
        assert_eq!(path_segment("a b?c/d"), "a%20b%3Fc%2Fd");
        assert_eq!(path_segment("é"), "%C3%A9");
    }

    #[tokio::test]
    async fn an_item_of_capabilities_that_the_binding_does_not_give_is_internal() {
        for body in [
            r#"[{"id":"a","available":"false"}]"#,
            r#"[{"id":"a","available":false}]"#,
            r#"[{"available":true}]"#,
        ] {
            let base = server(Box::leak(json_answer(body).into_boxed_str())).await;
            let failure = HttpClient::new(&base)
                .unwrap()
                .capabilities()
                .await
                .unwrap_err();
            assert_eq!(failure.kind, Kind::Internal, "{body}");
        }
        let base = server(Box::leak(
            json_answer(
                r#"[{"id":"a","available":true},{"id":"b","available":false,"reason":"off"}]"#,
            )
            .into_boxed_str(),
        ))
        .await;
        assert_eq!(
            HttpClient::new(&base)
                .unwrap()
                .capabilities()
                .await
                .unwrap(),
            [
                ("a".to_owned(), Availability::Available),
                ("b".to_owned(), Availability::unavailable("off"))
            ]
        );
    }

    #[tokio::test]
    async fn a_stream_that_is_not_text_event_stream_is_internal_at_once() {
        let base = server(Box::leak(json_answer("{}").into_boxed_str())).await;
        let Err(failure) = HttpClient::new(&base)
            .unwrap()
            .subscribe("e", &serde_json::json!({}), None, None)
            .await
        else {
            panic!("a stream that is not text/event-stream is not a subscription");
        };
        assert_eq!(failure.kind, Kind::Internal);
    }

    #[tokio::test]
    async fn the_reader_takes_lines_that_end_with_cr_lf_lf_or_cr() {
        for body in [
            "event: next\r\ndata: {\"eventId\":\"1\",\"name\":\"e\",\"timestamp\":\"t\",\"data\":{}}\r\n\r\nevent: complete\r\ndata:\r\n\r\n",
            "event: next\ndata: {\"eventId\":\"1\",\"name\":\"e\",\"timestamp\":\"t\",\"data\":{}}\n\nevent: complete\ndata:\n\n",
            "event: next\rdata: {\"eventId\":\"1\",\"name\":\"e\",\"timestamp\":\"t\",\"data\":{}}\r\revent: complete\rdata:\r\r",
        ] {
            let answer = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let base = server(Box::leak(answer.into_boxed_str())).await;
            let stream = HttpClient::new(&base)
                .unwrap()
                .subscribe("e", &serde_json::json!({}), None, None)
                .await
                .expect("the stream starts");
            let items: Vec<_> = stream.collect().await;
            assert_eq!(items.len(), 1, "{body:?}: {items:?}");
            assert_eq!(items[0].as_ref().unwrap().event_id, "1");
        }
    }
}
