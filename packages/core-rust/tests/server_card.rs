use std::sync::Arc;

use acid_cat_core::App;
use acid_cat_core::mcp::{McpOptions, McpSurface, ServerCard, WebhookOptions};
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

fn surface(options: McpOptions) -> McpSurface<Services> {
    McpSurface::new(app(), Arc::new(Services), options)
}

fn carded(webhooks: Option<WebhookOptions>) -> McpOptions {
    McpOptions {
        server_card: Some(ServerCard::named("dev.acid-cat/test")),
        webhooks,
        ..McpOptions::new("test", "1.2.3")
    }
}

async fn send(
    surface: &McpSurface<Services>,
    request: http::request::Builder,
) -> (http::response::Parts, Vec<u8>) {
    let request = request_body(request.body(Empty::new()).expect("a request"));
    let (parts, body) = surface.handle(request).await.into_parts();
    let bytes = body.collect().await.expect("the body").to_bytes();
    (parts, bytes.to_vec())
}

async fn read_card(surface: &McpSurface<Services>) -> Value {
    let request = Request::get("/mcp/server-card").header("host", "example.test:8080");
    let (_, body) = send(surface, request).await;
    serde_json::from_slice(&body).expect("a JSON card")
}

#[tokio::test]
async fn the_server_card_gives_the_configured_name_the_url_and_the_revisions() {
    let served = surface(carded(None));
    let request = Request::get("/mcp/server-card").header("host", "example.test:8080");
    let (head, body) = send(&served, request).await;
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

    let etag = head.headers["etag"].to_str().expect("a text ETag");
    let revalidate = Request::get("/mcp/server-card")
        .header("host", "example.test:8080")
        .header("if-none-match", format!("\"other\", {etag}"));
    assert_eq!(send(&served, revalidate).await.0.status, 304);

    let (head, _) = send(&served, Request::post("/mcp/server-card")).await;
    assert_eq!(head.status, 405);
    assert_eq!(head.headers["allow"], "GET, OPTIONS");

    let no_handshake = surface(McpOptions {
        handshake: false,
        ..carded(None)
    });
    assert_eq!(
        read_card(&no_handshake).await["remotes"][0]["supportedProtocolVersions"],
        json!(["2026-07-28"])
    );

    let behind_tls = surface(McpOptions {
        server_card: Some(ServerCard {
            url: Some("https://mcp.example.com/mcp".into()),
            ..ServerCard::named("dev.acid-cat/test")
        }),
        ..McpOptions::new("test", "1.2.3")
    });
    assert_eq!(
        read_card(&behind_tls).await["remotes"][0]["url"],
        "https://mcp.example.com/mcp"
    );
}

#[tokio::test]
async fn with_no_settings_the_server_serves_a_card_with_the_default_name_and_description() {
    let served = surface(McpOptions::new("test", "1.2.3"));
    let card = read_card(&served).await;
    assert_eq!(card["name"], "test.example/test");
    assert_eq!(card["version"], "1.2.3");
    assert_eq!(card["description"], "Serve nothing but a card.");
    let local = send(
        &served,
        Request::get("/mcp/server-card").header("host", "127.0.0.1:3000"),
    )
    .await;
    let local: Value = serde_json::from_slice(&local.1).expect("a JSON card");
    assert_eq!(local["name"], "local/test");

    let no_description = App::new()
        .target("mcp", ["mcp"])
        .build()
        .expect("the application conforms");
    let served = McpSurface::new(
        no_description,
        Arc::new(Services),
        McpOptions::new("test server", "0.0.0"),
    );
    let request = Request::get("/mcp/server-card").header("host", "localhost:3000");
    let (head, body) = send(&served, request).await;
    assert_eq!(head.status, 200);
    let card: Value = serde_json::from_slice(&body).expect("a JSON card");
    assert_eq!(card["name"], "localhost/test-server");
    assert_eq!(card["description"], "test server");
}

#[tokio::test]
async fn a_server_with_the_card_off_answers_404_and_starts_with_a_version_range() {
    let served = surface(McpOptions {
        server_card: None,
        ..McpOptions::new("test", "^1.2.3")
    });
    let (head, body) = send(&served, Request::get("/mcp/server-card")).await;
    assert_eq!(head.status, 404);
    assert!(body.is_empty());
}

#[tokio::test]
async fn the_card_gives_the_public_signing_keys_and_the_egress_ranges() {
    let ranges = vec!["203.0.113.0/24".to_owned(), "2001:db8::/32".to_owned()];
    let served = surface(carded(Some(WebhookOptions {
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

    let plain = surface(carded(Some(WebhookOptions::default())));
    assert!(
        read_card(&plain).await["remotes"][0]
            .get("extensionsInfo")
            .is_none()
    );
}

fn panic_message(options: McpOptions) -> String {
    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| surface(options)))
        .err()
        .expect("the surface panics");
    panic
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| panic.downcast_ref::<&str>().map(|text| (*text).to_owned()))
        .unwrap_or_default()
}

#[test]
fn invalid_card_or_webhook_options_panic_when_the_surface_starts() {
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
        server_card: Some(ServerCard::named("no-slash")),
        ..McpOptions::new("test", "1.2.3")
    });
    assert!(message.contains("namespace/name"), "{message}");
    let message = panic_message(McpOptions {
        server_card: Some(ServerCard {
            description: Some("x".repeat(101)),
            ..ServerCard::default()
        }),
        ..McpOptions::new("test", "1.2.3")
    });
    assert!(message.contains("description"), "{message}");
    for url in ["ftp://mcp.example.com/mcp", "http://%"] {
        let message = panic_message(McpOptions {
            server_card: Some(ServerCard {
                url: Some(url.into()),
                ..ServerCard::default()
            }),
            ..McpOptions::new("test", "1.2.3")
        });
        assert!(message.contains("http or https URL"), "{url}: {message}");
    }
    let message = panic_message(McpOptions::new("test", "^1.2.3"));
    assert!(message.contains("not a range"), "{message}");
}

#[test]
fn signing_keys_or_egress_ranges_with_the_card_off_panic_when_the_surface_starts() {
    for webhooks in [
        WebhookOptions {
            signing_keys: vec![private_jwk("one", 1)],
            ..WebhookOptions::default()
        },
        WebhookOptions {
            egress_ip_ranges: vec!["203.0.113.0/24".into()],
            ..WebhookOptions::default()
        },
    ] {
        let message = panic_message(McpOptions {
            webhooks: Some(webhooks),
            server_card: None,
            ..McpOptions::new("test", "1.2.3")
        });
        assert!(message.contains("need a Server Card"), "{message}");
    }
}
