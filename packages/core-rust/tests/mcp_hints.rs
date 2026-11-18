use std::sync::Arc;

use acid_cat_core::mcp::{McpBinding, McpOptions, PROTOCOL_VERSION};
use acid_cat_core::remote::request_body;
use acid_cat_core::{App, Capability};
use http::Request;
use http_body_util::{BodyExt, Full};
use serde_json::{Value, json};

#[tokio::test]
async fn tools_list_gives_the_destructive_and_idempotent_hints_of_a_capability() {
    let app = App::new()
        .target("mcp", ["mcp"])
        .capability(
            Capability::<()>::new("notes.note.replace", "Replace the text of a note.")
                .audience(["mcp"])
                .destructive(true)
                .idempotent(true)
                .run(|(), _| async { Ok(()) }),
        )
        .capability(
            Capability::<()>::new("notes.count.read", "Read the number of notes.")
                .audience(["mcp"])
                .read_only()
                .run(|(), _| async { Ok(()) }),
        )
        .build()
        .expect("the application conforms");
    let binding = McpBinding::new(app, Arc::new(()), McpOptions::new("notes", "0.0.0"));
    let list = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/list",
        "params": { "_meta": { "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION } },
    });
    let request = request_body(
        Request::post("/")
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .header("mcp-protocol-version", PROTOCOL_VERSION)
            .body(Full::new(bytes::Bytes::from(list.to_string())))
            .expect("a request"),
    );
    let bytes = binding
        .handle(request)
        .await
        .into_body()
        .collect()
        .await
        .expect("the body")
        .to_bytes();
    let body: Value = serde_json::from_slice(&bytes).expect("a JSON answer");
    let annotations = |name: &str| {
        body["result"]["tools"]
            .as_array()
            .expect("the tools")
            .iter()
            .find(|tool| tool["name"] == name)
            .map(|tool| tool["annotations"].clone())
    };

    assert_eq!(
        annotations("notes.note.replace"),
        Some(json!({ "readOnlyHint": false, "destructiveHint": true, "idempotentHint": true }))
    );
    assert_eq!(
        annotations("notes.count.read"),
        Some(json!({ "readOnlyHint": true }))
    );
}
