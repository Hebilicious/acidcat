//! A context for each request: the HTTP and MCP bindings make it from the head of the request, a capability reads the
//! caller from it and the target from the call, and a refusal answers the request instead.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use acid_cat_core::App;
use acid_cat_core::http::{HttpBinding, HttpOptions};
use acid_cat_core::mcp::{McpBinding, McpOptions, PROTOCOL_VERSION};
use acid_cat_core::remote::{Refusal, request_body};
use http::Request;
use http_body_util::{BodyExt, Full};
use serde_json::{Value, json};

/// The services of one request: who calls, and a counter of the contexts that are still alive.
struct Caller {
    name: String,
    alive: Arc<AtomicUsize>,
}

impl Drop for Caller {
    fn drop(&mut self) {
        self.alive.fetch_sub(1, Ordering::SeqCst);
    }
}

type Capability = acid_cat_core::Capability<Caller>;
type Event = acid_cat_core::Event<Caller>;

#[derive(serde::Serialize, schemars::JsonSchema)]
struct Who {
    caller: String,
    target: String,
}

fn app() -> Arc<acid_cat_core::Application<Caller>> {
    App::new()
        .target("api", ["http"])
        .target("mcp", ["mcp"])
        .capability(
            Capability::new("who.get", "Give the caller and the target of the call.")
                .audience(["api", "mcp"])
                .read_only()
                .output::<Who>()
                .run(|(), call| async move {
                    Ok(Who {
                        caller: call.context().name.clone(),
                        target: call.target().to_owned(),
                    })
                }),
        )
        .event(
            Event::new(
                "who.seen",
                "Give the caller and the target of the subscription once.",
            )
            .audience(["api"])
            .payload::<Who>()
            .subscribe(|(), subscription| {
                let who = Who {
                    caller: subscription.context().name.clone(),
                    target: subscription.target().to_owned(),
                };
                futures::stream::iter([Ok(acid_cat_core::Emitted::new(who))])
            }),
        )
        .build()
        .expect("the application conforms")
}

/// Make a context from the token of `Authorization: Bearer <name>`, or refuse the request with 401.
fn caller(
    alive: &Arc<AtomicUsize>,
) -> impl Fn(&http::request::Parts) -> std::future::Ready<Result<Caller, Refusal>> + Send + Sync + 'static
{
    let alive = alive.clone();
    move |parts| {
        let name = parts
            .headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .map(str::to_owned);
        std::future::ready(match name {
            Some(name) => {
                alive.fetch_add(1, Ordering::SeqCst);
                Ok(Caller {
                    name,
                    alive: alive.clone(),
                })
            }
            None => Err(Refusal::new(401, "Give a token.").header("WWW-Authenticate", "Bearer")),
        })
    }
}

async fn answer(response: http::Response<acid_cat_core::remote::ResponseBody>) -> (u16, Value) {
    let status = response.status().as_u16();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("the body")
        .to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// A `POST` request with a JSON body, and the token of the caller if it has one.
fn post(path: &str, token: Option<&str>) -> http::request::Builder {
    let mut request = Request::post(path).header("content-type", "application/json");
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    request
}

#[tokio::test]
async fn through_http_the_capability_gets_the_caller_of_the_request_and_the_target() {
    let alive = Arc::new(AtomicUsize::new(0));
    let binding = HttpBinding::with_request_context(app(), caller(&alive), HttpOptions::default());
    let request = |token: Option<&str>| {
        request_body(
            post("/capabilities/who.get", token)
                .body(Full::new(bytes::Bytes::from("{}")))
                .expect("a request"),
        )
    };

    let (status, body) = answer(binding.handle(request(Some("dashboard"))).await).await;
    assert_eq!(status, 200);
    assert_eq!(
        body,
        json!({ "ok": true, "value": { "caller": "dashboard", "target": "api" } })
    );
    assert_eq!(
        alive.load(Ordering::SeqCst),
        0,
        "the context is dropped after the answer"
    );

    let refused = binding.handle(request(None)).await;
    assert_eq!(refused.headers()["www-authenticate"], "Bearer");
    let (status, body) = answer(refused).await;
    assert_eq!(status, 401);
    assert_eq!(body, json!({ "message": "Give a token." }));
}

#[tokio::test]
async fn through_mcp_the_capability_gets_the_caller_of_the_request_and_the_target() {
    let alive = Arc::new(AtomicUsize::new(0));
    let binding =
        McpBinding::with_request_context(app(), caller(&alive), McpOptions::new("who", "0.0.0"));
    let call = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "who.get",
            "arguments": {},
            "_meta": { "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION },
        },
    });
    let request = |token: Option<&str>| {
        request_body(
            post("/", token)
                .header("accept", "application/json, text/event-stream")
                .header("mcp-protocol-version", PROTOCOL_VERSION)
                .body(Full::new(bytes::Bytes::from(call.to_string())))
                .expect("a request"),
        )
    };

    let (status, body) = answer(binding.handle(request(Some("bank-agent"))).await).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body["result"]["structuredContent"],
        json!({ "caller": "bank-agent", "target": "mcp" })
    );
    assert_eq!(
        alive.load(Ordering::SeqCst),
        0,
        "the context is dropped after the answer"
    );

    let refused = binding.handle(request(None)).await;
    assert_eq!(refused.headers()["www-authenticate"], "Bearer");
    let (status, body) = answer(refused).await;
    assert_eq!(status, 401);
    assert_eq!(body, json!({ "message": "Give a token." }));
}

#[tokio::test]
async fn a_refusal_answers_with_one_media_type_application_json() {
    let binding = HttpBinding::with_request_context(
        app(),
        |_: &http::request::Parts| {
            std::future::ready(Err::<Caller, _>(
                Refusal::new(403, "No.").header("Content-Type", "text/plain"),
            ))
        },
        HttpOptions::default(),
    );
    let refused = binding
        .handle(request_body(
            post("/capabilities/who.get", None)
                .body(Full::new(bytes::Bytes::from("{}")))
                .expect("a request"),
        ))
        .await;
    let types: Vec<_> = refused.headers().get_all("content-type").iter().collect();
    assert_eq!(types, ["application/json"]);
    assert_eq!(answer(refused).await.0, 403);
}

#[test]
#[should_panic(expected = "from 400 to 599")]
fn a_refusal_needs_a_status_from_400_to_599() {
    let _ = Refusal::new(200, "Not a refusal.");
}

#[tokio::test]
async fn through_http_an_event_gets_the_target_and_the_context_lives_until_the_stream_ends() {
    let alive = Arc::new(AtomicUsize::new(0));
    let binding = HttpBinding::with_request_context(app(), caller(&alive), HttpOptions::default());
    let response = binding
        .handle(request_body(
            post("/events/who.seen", Some("dashboard"))
                .body(Full::new(bytes::Bytes::from("{}")))
                .expect("a request"),
        ))
        .await;
    assert_eq!(response.status(), 200);
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("the stream")
        .to_bytes();
    let text = String::from_utf8_lossy(&bytes);
    assert!(
        text.contains(r#""caller":"dashboard""#) && text.contains(r#""target":"api""#),
        "{text}"
    );
    assert!(text.contains("event: complete"), "{text}");
    assert_eq!(
        alive.load(Ordering::SeqCst),
        0,
        "the context is dropped when the stream ends"
    );
}
