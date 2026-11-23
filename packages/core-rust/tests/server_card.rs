use std::sync::Arc;

use acid_cat_core::App;
use acid_cat_core::mcp::{McpBinding, McpOptions, ServerCard, WebhookOptions};
use acid_cat_core::remote::request_body;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use http::Request;
use http_body_util::{BodyExt, Empty};
use serde_json::{Value, json};

struct Services;

fn app() -> Arc<acid_cat_core::Application<Services>> {
    App::new()
        .description("Serve nothing but a card.")
        .target("mcp", ["mcp"])
        .build()
        .expect("the application conforms")
}

fn private_jwk(kid: &str, seed: u8) -> Value {
    json!({ "kty": "OKP", "crv": "Ed25519", "kid": kid, "d": URL_SAFE_NO_PAD.encode([seed; 32]) })
}

fn binding(options: McpOptions) -> McpBinding<Services> {
    McpBinding::new(app(), Arc::new(Services), options)
}

fn carded(webhooks: Option<WebhookOptions>) -> McpOptions {
    McpOptions {
        server_card: Some(ServerCard::new("dev.acid-cat/test")),
        webhooks,
        ..McpOptions::new("test", "1.2.3")
    }
}

async fn send(
    binding: &McpBinding<Services>,
    request: http::request::Builder,
) -> (http::response::Parts, Vec<u8>) {
    let request = request_body(request.body(Empty::new()).expect("a request"));
    let (parts, body) = binding.handle(request).await.into_parts();
    let bytes = body.collect().await.expect("the body").to_bytes();
    (parts, bytes.to_vec())
}

async fn read_card(binding: &McpBinding<Services>) -> Value {
    let request = Request::get("/mcp/server-card").header("host", "example.test:8080");
    let (_, body) = send(binding, request).await;
    serde_json::from_slice(&body).expect("a JSON card")
}

#[tokio::test]
async fn the_server_card_tells_how_to_connect_and_honors_its_entity_tag() {
    let served = binding(carded(None));
    let request = Request::get("/mcp/server-card").header("host", "example.test:8080");
    let (head, body) = send(&served, request).await;
    assert_eq!(head.status, 200);
    let header = |name: &str| {
        head.headers[name]
            .to_str()
            .expect("a text header")
            .to_owned()
    };
    assert_eq!(header("content-type"), "application/mcp-server-card+json");
    assert_eq!(header("access-control-allow-origin"), "*");
    assert_eq!(header("access-control-allow-methods"), "GET");
    assert_eq!(
        header("access-control-allow-headers"),
        "Content-Type, If-None-Match"
    );
    assert_eq!(header("access-control-expose-headers"), "ETag");
    assert_eq!(header("cache-control"), "public, max-age=3600");
    let etag = header("etag");
    assert_eq!(etag.len(), 34, "{etag}");
    let card: Value = serde_json::from_slice(&body).expect("a JSON card");
    assert_eq!(
        card,
        json!({
            "$schema": "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
            "name": "dev.acid-cat/test",
            "version": "1.2.3",
            "description": "Serve nothing but a card.",
            "remotes": [{
                "type": "streamable-http",
                "url": "http://example.test:8080/mcp",
                "supportedProtocolVersions": ["2026-07-28", "2025-11-25", "2025-06-18"],
            }],
        })
    );
    let members: Vec<&String> = card.as_object().expect("an object").keys().collect();
    assert_eq!(
        members,
        ["$schema", "name", "version", "description", "remotes"]
    );

    let absolute = send(&served, Request::get("https://card.test/mcp/server-card")).await;
    let absolute: Value = serde_json::from_slice(&absolute.1).expect("a JSON card");
    assert_eq!(absolute["remotes"][0]["url"], "https://card.test/mcp");

    let revalidate = Request::get("/mcp/server-card")
        .header("host", "example.test:8080")
        .header("if-none-match", format!("\"other\", {etag}"));
    let (head, body) = send(&served, revalidate).await;
    assert_eq!(head.status, 304);
    assert!(body.is_empty());
    assert_eq!(head.headers["etag"], etag.as_str());
    assert_eq!(head.headers["access-control-allow-origin"], "*");

    let (head, body) = send(&served, Request::options("/mcp/server-card")).await;
    assert_eq!(head.status, 204);
    assert!(body.is_empty());
    assert!(head.headers.get("etag").is_none());
    assert_eq!(head.headers["access-control-allow-methods"], "GET");
    assert_eq!(head.headers["cache-control"], "public, max-age=3600");

    let (head, _) = send(&served, Request::post("/mcp/server-card")).await;
    assert_eq!(head.status, 405);
    assert_eq!(head.headers["allow"], "GET, OPTIONS");

    let no_handshake = binding(McpOptions {
        handshake: false,
        ..carded(None)
    });
    assert_eq!(
        read_card(&no_handshake).await["remotes"][0]["supportedProtocolVersions"],
        json!(["2026-07-28"])
    );

    let behind_tls = binding(McpOptions {
        server_card: Some(ServerCard {
            url: Some("https://mcp.example.com/mcp".into()),
            ..ServerCard::new("dev.acid-cat/test")
        }),
        ..McpOptions::new("test", "1.2.3")
    });
    assert_eq!(
        read_card(&behind_tls).await["remotes"][0]["url"],
        "https://mcp.example.com/mcp"
    );
}

#[tokio::test]
async fn a_server_with_no_card_answers_404() {
    let served = binding(McpOptions::new("test", "1.2.3"));
    let (head, body) = send(&served, Request::get("/mcp/server-card")).await;
    assert_eq!(head.status, 404);
    assert!(body.is_empty());
}

#[tokio::test]
async fn the_card_gives_the_public_signing_keys_and_the_egress_ranges() {
    let ranges = vec!["203.0.113.0/24".to_owned(), "2001:db8::/32".to_owned()];
    let served = binding(carded(Some(WebhookOptions {
        signing_keys: vec![private_jwk("one", 1), private_jwk("two", 2)],
        egress_ip_ranges: ranges.clone(),
        ..WebhookOptions::default()
    })));
    let webhooks = &read_card(&served).await["remotes"][0]["extensionsInfo"]["io.modelcontextprotocol/events"]
        ["webhooks"];
    assert_eq!(webhooks["egressIpRanges"], json!(ranges));
    let keys = webhooks["signingKeys"]["keys"]
        .as_array()
        .expect("a JWK set");
    for (key, (kid, seed)) in keys.iter().zip([("one", 1u8), ("two", 2u8)]) {
        let public = ed25519_dalek::SigningKey::from_bytes(&[seed; 32]).verifying_key();
        assert_eq!(
            key,
            &json!({ "kty": "OKP", "crv": "Ed25519", "kid": kid, "x": URL_SAFE_NO_PAD.encode(public.to_bytes()) })
        );
        assert!(key.get("d").is_none(), "the card has no private key");
    }
    assert_eq!(keys.len(), 2);

    let plain = binding(carded(Some(WebhookOptions::default())));
    assert!(
        read_card(&plain).await["remotes"][0]
            .get("extensionsInfo")
            .is_none()
    );
}

fn panic_message(options: McpOptions) -> String {
    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| binding(options)))
        .err()
        .expect("the binding panics");
    panic
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| panic.downcast_ref::<&str>().map(|text| (*text).to_owned()))
        .unwrap_or_default()
}

#[test]
fn invalid_card_or_webhook_options_panic_when_the_binding_starts() {
    let with_webhooks = |webhooks: WebhookOptions| carded(Some(webhooks));
    for range in ["10.0.0.0/33", "10.0.0.0", "bad/8", "10.0.0.0/08", "::/129"] {
        let message = panic_message(with_webhooks(WebhookOptions {
            egress_ip_ranges: vec![range.to_owned()],
            ..WebhookOptions::default()
        }));
        assert!(message.contains("not CIDR text"), "{range}: {message}");
    }
    let mut public_only = private_jwk("one", 1);
    public_only["d"] = json!(URL_SAFE_NO_PAD.encode([1u8; 31]));
    let message = panic_message(with_webhooks(WebhookOptions {
        signing_keys: vec![public_only],
        ..WebhookOptions::default()
    }));
    assert!(message.contains("private Ed25519 JWK"), "{message}");
    let message = panic_message(with_webhooks(WebhookOptions {
        signing_keys: vec![private_jwk("same", 1), private_jwk("same", 2)],
        ..WebhookOptions::default()
    }));
    assert!(message.contains("more than one time"), "{message}");
    let message = panic_message(McpOptions {
        server_card: Some(ServerCard::new("no-slash")),
        ..McpOptions::new("test", "1.2.3")
    });
    assert!(message.contains("namespace/name"), "{message}");
    let message = panic_message(McpOptions {
        server_card: Some(ServerCard {
            description: Some("x".repeat(101)),
            ..ServerCard::new("dev.acid-cat/test")
        }),
        ..McpOptions::new("test", "1.2.3")
    });
    assert!(message.contains("description"), "{message}");
    let message = panic_message(McpOptions {
        server_card: Some(ServerCard {
            url: Some("ftp://mcp.example.com/mcp".into()),
            ..ServerCard::new("dev.acid-cat/test")
        }),
        ..McpOptions::new("test", "1.2.3")
    });
    assert!(message.contains("http or https URL"), "{message}");
}
