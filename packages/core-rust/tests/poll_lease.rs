use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use acid_cat_core::mcp::{McpOptions, McpSurface, PollOptions};
use acid_cat_core::remote::request_body;
use acid_cat_core::{App, Emitted, Event, NoPayload, Subscription};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use http::Request;
use http_body_util::{BodyExt, Full};
use serde_json::{Value, json};
use tokio::time::{Instant, advance};

#[derive(Default)]
struct Services {
    watching: AtomicUsize,
    unwatched: tokio::sync::Notify,
}

struct Unwatch(Arc<Services>);

impl Drop for Unwatch {
    fn drop(&mut self) {
        self.0.watching.fetch_sub(1, Ordering::SeqCst);
        self.0.unwatched.notify_one();
    }
}

const LEASE: Duration = Duration::from_secs(60);

fn surface(services: &Arc<Services>) -> McpSurface<Services> {
    let app = App::new()
        .target("mcp", ["mcp"])
        .event(
            Event::new(
                "test.watch",
                "Give no occurrence until the subscription ends.",
            )
            .audience(["mcp"])
            .subscribe(|(), subscription: Subscription<Services>| {
                let services = subscription.context_arc();
                services.watching.fetch_add(1, Ordering::SeqCst);
                let unwatch = Unwatch(services);
                futures::stream::unfold(unwatch, |unwatch| async move {
                    std::future::pending::<()>().await;
                    Some((Ok(Emitted::new(NoPayload {})), unwatch))
                })
            }),
        )
        .build()
        .expect("the application conforms");
    McpSurface::new(
        app,
        services.clone(),
        McpOptions {
            poll: PollOptions {
                lease: LEASE,
                ..PollOptions::default()
            },
            ..McpOptions::new("test", "0.0.0")
        },
    )
}

async fn poll(surface: &McpSurface<Services>, cursor: Option<&str>) -> String {
    let mut params = json!({ "name": "test.watch", "_meta": { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } });
    if let Some(cursor) = cursor {
        params["cursor"] = json!(cursor);
    }
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "events/poll", "params": params });
    let request = Request::post("/mcp")
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", "2026-07-28")
        .header("mcp-method", "events/poll")
        .header("mcp-name", "test.watch")
        .body(Full::new(body.to_string().into()))
        .expect("a request");
    let answer = surface.handle(request_body(request)).await;
    let bytes = answer
        .into_body()
        .collect()
        .await
        .expect("the body")
        .to_bytes();
    let message: Value = serde_json::from_slice(&bytes).expect("a JSON message");
    message["result"]["cursor"]
        .as_str()
        .unwrap_or_else(|| panic!("events/poll gives a cursor: {message}"))
        .to_owned()
}

/// The lease of a poll cursor of this core: `p1.` and the base64url of the JSON array `[lease, position, provider]`.
fn lease_of(cursor: &str) -> String {
    let encoded = cursor
        .strip_prefix("p1.")
        .expect("a poll cursor of this core");
    let parts: Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).expect("base64url")).expect("JSON");
    parts[0].as_str().expect("a lease").to_owned()
}

#[tokio::test(start_paused = true)]
async fn through_http_a_lease_that_gets_no_poll_for_the_lease_time_ends_and_its_subscription_is_cancelled()
 {
    let services = Arc::new(Services::default());
    let served = surface(&services);
    let started = poll(&served, None).await;
    assert_eq!(services.watching.load(Ordering::SeqCst), 1);

    advance(LEASE - Duration::from_millis(1)).await;
    let renewed = poll(&served, Some(&started)).await;
    assert_eq!(
        lease_of(&renewed),
        lease_of(&started),
        "a poll before the end renews the lease"
    );
    let last_poll = Instant::now();

    // With the clock paused, Tokio moves it to the next timer when every task waits: the end of the lease, or the
    // hour of this wait when the lease never ends.
    let ended =
        tokio::time::timeout(Duration::from_secs(3600), services.unwatched.notified()).await;
    assert!(ended.is_ok(), "the lease did not end");
    assert_eq!(
        last_poll.elapsed(),
        LEASE,
        "the lease ends the lease time after the last poll"
    );
    assert_eq!(services.watching.load(Ordering::SeqCst), 0);
    let restarted = poll(&served, Some(&renewed)).await;
    assert_ne!(
        lease_of(&restarted),
        lease_of(&started),
        "a poll after the end starts a new lease"
    );
    served.close().await;
}
