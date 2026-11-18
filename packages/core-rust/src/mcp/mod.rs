//! The MCP binding (spec/bindings/mcp.md): tools, and events through the MCP events extension. The HTTP and the
//! stdio transports share this module.

mod http;
mod poll;
mod stdio;
mod webhook;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use crate::outcome::{CallFailure, Kind, Outcome};
use crate::schema::bundle;
use crate::session::{Session, SubscribeOptions, is_max_age_ms};
use crate::subscription::Occurrences;

pub use http::{McpBinding, McpOptions, Principal};
pub use poll::PollOptions;
pub use stdio::{McpStdioOptions, run_stdio, serve_stdio};
pub use webhook::{Allow, WebhookOptions};

/// The revision of MCP that the binding serves.
pub const PROTOCOL_VERSION: &str = crate::facts_generated::MCP_PROTOCOL_VERSION;

/// The revisions with an `initialize` handshake that the binding serves, the latest first.
pub const HANDSHAKE_VERSIONS: [&str; 2] = ["2025-11-25", "2025-06-18"];

pub(crate) const PROTOCOL_VERSION_KEY: &str = "io.modelcontextprotocol/protocolVersion";
pub(crate) const SUBSCRIPTION_ID_KEY: &str = crate::facts_generated::MCP_SUBSCRIPTION_ID;
pub(crate) const SERVER_INFO_KEY: &str = "io.modelcontextprotocol/serverInfo";
pub(crate) const EVENTS_EXTENSION: &str = crate::facts_generated::MCP_EVENTS_EXTENSION;

/// The JSON-RPC errors of the MCP events extension. Their numbers are not final in SEP-3415.
pub(crate) mod codes {
    pub use crate::facts_generated::event_errors::*;
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const UNKNOWN_TOOL: i64 = crate::facts_generated::MCP_UNKNOWN_TOOL;
}

#[derive(Clone, Debug)]
pub(crate) struct RpcError {
    pub(crate) code: i64,
    pub(crate) message: String,
    pub(crate) data: Option<Value>,
}

impl RpcError {
    pub(crate) fn new(code: i64, message: impl Into<String>) -> Self {
        RpcError {
            code,
            message: message.into(),
            data: None,
        }
    }

    pub(crate) fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }

    pub(crate) fn invalid_params(message: impl Into<String>) -> Self {
        RpcError::new(codes::INVALID_PARAMS, message)
    }

    pub(crate) fn to_json(&self) -> Value {
        let mut error = json!({ "code": self.code, "message": self.message });
        if let Some(data) = &self.data {
            error["data"] = data.clone();
        }
        error
    }

    pub(crate) fn unsupported_webhook() -> Self {
        RpcError::new(codes::UNSUPPORTED, "Unsupported")
            .with_data(json!({ "feature": "deliveryMode", "value": "webhook" }))
    }
}

pub(crate) type RpcAnswer = Result<Map<String, Value>, RpcError>;

pub(crate) fn response(id: &Value, answer: Result<Value, RpcError>) -> Value {
    match answer {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err(error) => json!({ "jsonrpc": "2.0", "id": id, "error": error.to_json() }),
    }
}

pub(crate) fn server_info(name: &str, version: &str) -> Value {
    json!({ SERVER_INFO_KEY: { "name": name, "version": version } })
}

pub(crate) type OpenSession<C> = Arc<dyn Fn() -> Session<C> + Send + Sync>;

pub(crate) type KeyGates<L> = Mutex<HashMap<String, Gate<L>>>;

pub(crate) struct Gate<L> {
    lock: Arc<L>,
    holders: usize,
}

pub(crate) struct KeyGate<'a, L> {
    gates: &'a KeyGates<L>,
    key: String,
    pub(crate) lock: Arc<L>,
}

impl<'a, L: Default> KeyGate<'a, L> {
    pub(crate) fn enter(gates: &'a KeyGates<L>, key: &str) -> Self {
        let mut gates_by_key = lock_gates(gates);
        let gate = gates_by_key.entry(key.to_owned()).or_insert_with(|| Gate {
            lock: Arc::default(),
            holders: 0,
        });
        gate.holders += 1;
        KeyGate {
            gates,
            key: key.to_owned(),
            lock: gate.lock.clone(),
        }
    }
}

impl<L> Drop for KeyGate<'_, L> {
    fn drop(&mut self) {
        let mut gates = lock_gates(self.gates);
        if let Some(gate) = gates.get_mut(&self.key) {
            gate.holders -= 1;
            if gate.holders == 0 {
                gates.remove(&self.key);
            }
        }
    }
}

fn lock_gates<L>(gates: &KeyGates<L>) -> std::sync::MutexGuard<'_, HashMap<String, Gate<L>>> {
    gates
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn list_tools<C: Send + Sync + 'static>(session: &Session<C>) -> Vec<Value> {
    let empty = Map::new();
    let view = session.view();
    let types = view
        .get("$defs")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    session
        .capability_ids()
        .iter()
        .filter(|id| session.availability(id).is_some_and(|availability| availability.is_available()))
        .filter_map(|id| {
            let capability = view.get("capabilities")?.get(id.as_str())?;
            let mut tool = json!({
                "name": id,
                "description": capability.get("description").cloned().unwrap_or(Value::Null),
                "inputSchema": bundle(capability.get("input").unwrap_or(&json!({ "type": "object" })), types),
            });
            if let Some(output) = capability.get("output").map(|output| bundle(output, types))
                && output.get("type") == Some(&json!("object"))
            {
                tool["outputSchema"] = output;
            }
            let mut annotations = json!({ "readOnlyHint": capability.get("readOnly") == Some(&json!(true)) });
            for (member, hint) in [("destructive", "destructiveHint"), ("idempotent", "idempotentHint")] {
                if let Some(value) = capability.get(member) {
                    annotations[hint] = value.clone();
                }
            }
            tool["annotations"] = annotations;
            Some(tool)
        })
        .collect()
}

pub(crate) fn has_object_output<C: Send + Sync + 'static>(session: &Session<C>, id: &str) -> bool {
    let empty = Map::new();
    let view = session.view();
    let types = view
        .get("$defs")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    view.pointer(&format!(
        "/capabilities/{}/output",
        id.replace('~', "~0").replace('/', "~1")
    ))
    .is_some_and(|output| bundle(output, types).get("type") == Some(&json!("object")))
}

pub(crate) fn tool_result(outcome: &Outcome, has_output_schema: bool) -> Value {
    let text = |value: &Value| json!([{ "type": "text", "text": value.to_string() }]);
    match outcome {
        Outcome::CallFailure(failure) => {
            json!({ "content": text(&failure.to_json()), "isError": true })
        }
        Outcome::Failure(error) => {
            json!({ "content": text(&json!({ "ok": false, "error": error })), "isError": true })
        }
        Outcome::Value(value) if has_output_schema => {
            json!({ "content": text(value), "structuredContent": value })
        }
        Outcome::Value(value) => json!({ "content": text(value) }),
    }
}

pub(crate) async fn call_tool<C: Send + Sync + 'static>(
    session: &Session<C>,
    params: &Map<String, Value>,
    cancel: &CancellationToken,
) -> Result<Value, RpcError> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !session
        .availability(name)
        .is_some_and(|availability| availability.is_available())
    {
        return Err(RpcError::new(
            codes::UNKNOWN_TOOL,
            format!("Tool '{name}' not found"),
        ));
    }
    let input = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let outcome = session.invoke(name, input, cancel).await;
    Ok(tool_result(&outcome, has_object_output(session, name)))
}

pub(crate) fn serves_events<C: Send + Sync + 'static>(session: &Session<C>) -> bool {
    !session.event_ids().is_empty()
}

pub(crate) fn capabilities<C: Send + Sync + 'static>(
    session: &Session<C>,
    list_changed: bool,
) -> Value {
    let mut capabilities = json!({ "tools": { "listChanged": list_changed } });
    if serves_events(session) {
        capabilities["extensions"] = json!({ EVENTS_EXTENSION: {} });
    }
    capabilities
}

pub(crate) fn list_events<C: Send + Sync + 'static>(
    session: &Session<C>,
    webhook: bool,
) -> Vec<Value> {
    let empty = Map::new();
    let view = session.view();
    let types = view
        .get("$defs")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let object = json!({ "type": "object" });
    session
        .event_ids()
        .iter()
        .filter_map(|id| {
            let event = view.get("events")?.get(id.as_str())?;
            Some(json!({
                "name": id,
                "description": event.get("description").cloned().unwrap_or(Value::Null),
                "delivery": if webhook { json!(["push", "poll", "webhook"]) } else { json!(["push", "poll"]) },
                "inputSchema": event.get("input").map_or_else(|| object.clone(), |input| bundle(input, types)),
                "payloadSchema": event.get("payload").map_or_else(|| object.clone(), |payload| bundle(payload, types)),
            }))
        })
        .collect()
}

pub(crate) struct SubscriptionParams {
    pub(crate) name: String,
    pub(crate) input: Value,
    pub(crate) cursor: Option<String>,
    pub(crate) max_age_ms: MaxAge,
}

pub(crate) enum MaxAge {
    Absent,
    Valid(u64),
    Invalid,
}

impl MaxAge {
    fn read(value: Option<&Value>) -> Self {
        match value {
            None | Some(Value::Null) => MaxAge::Absent,
            Some(Value::Number(number)) => match number.as_f64() {
                Some(ms) if is_max_age_ms(ms) => MaxAge::Valid(ms as u64),
                _ => MaxAge::Invalid,
            },
            Some(_) => MaxAge::Invalid,
        }
    }

    pub(crate) fn is_invalid(&self) -> bool {
        matches!(self, MaxAge::Invalid)
    }

    pub(crate) fn subscribe_option(&self) -> Option<f64> {
        match self {
            MaxAge::Absent => None,
            MaxAge::Valid(ms) => Some(*ms as f64),
            MaxAge::Invalid => Some(f64::NAN),
        }
    }
}

pub(crate) fn subscription_params(
    params: &Map<String, Value>,
) -> Result<SubscriptionParams, RpcError> {
    let cursor = match params.get("cursor") {
        None | Some(Value::Null) => None,
        Some(Value::String(cursor)) => Some(cursor.clone()),
        Some(_) => return Err(RpcError::invalid_params("cursor must be a string or null.")),
    };
    let max_age_ms = MaxAge::read(params.get("maxAgeMs"));
    Ok(SubscriptionParams {
        name: params
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        input: params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({})),
        cursor,
        max_age_ms,
    })
}

pub(crate) fn subscribe_error(failure: &CallFailure) -> RpcError {
    match failure.kind {
        Kind::UnknownCapability => RpcError::new(codes::NOT_FOUND, failure.message.clone())
            .with_data(json!({ "kind": "event" })),
        Kind::InvalidInput => RpcError::invalid_params(failure.message.clone()),
        _ => RpcError::new(codes::INTERNAL, failure.message.clone()),
    }
}

pub(crate) struct EventStream {
    occurrences: Occurrences,
    id: Value,
    result_meta: Value,
    heartbeat: Duration,
    state: StreamState,
    last_cursor: Option<String>,
}

enum StreamState {
    Start,
    Open,
    Ended,
}

impl EventStream {
    pub(crate) fn start<C: Send + Sync + 'static>(
        session: &Session<C>,
        id: Value,
        params: &Map<String, Value>,
        result_meta: Value,
        heartbeat: Duration,
    ) -> Result<Self, RpcError> {
        let read = subscription_params(params)?;
        let occurrences = session
            .subscribe(
                &read.name,
                read.input,
                SubscribeOptions {
                    cursor: read.cursor,
                    max_age_ms: read.max_age_ms.subscribe_option(),
                    cancel: CancellationToken::new(),
                },
            )
            .map_err(|failure| subscribe_error(&failure))?;
        Ok(EventStream {
            occurrences,
            id,
            result_meta,
            heartbeat,
            state: StreamState::Start,
            last_cursor: None,
        })
    }

    fn notification(&self, method: &str, mut members: Value) -> Value {
        members["_meta"] = json!({ SUBSCRIPTION_ID_KEY: self.id });
        json!({ "jsonrpc": "2.0", "method": format!("notifications/events/{method}"), "params": members })
    }

    fn result(&self) -> Value {
        let mut meta = self.result_meta.clone();
        meta[SUBSCRIPTION_ID_KEY] = self.id.clone();
        json!({ "jsonrpc": "2.0", "id": self.id, "result": { "resultType": "complete", "_meta": meta } })
    }

    pub(crate) async fn next(&mut self) -> Option<Vec<Value>> {
        match self.state {
            StreamState::Ended => return None,
            StreamState::Start => {
                self.state = StreamState::Open;
                return Some(vec![
                    self.notification("active", json!({ "truncated": false })),
                ]);
            }
            StreamState::Open => {}
        }
        let next = match tokio::time::timeout(self.heartbeat, self.occurrences.next()).await {
            Err(_) => {
                return Some(vec![
                    self.notification("heartbeat", json!({ "cursor": self.last_cursor })),
                ]);
            }
            Ok(next) => next,
        };
        match next {
            None => {
                self.state = StreamState::Ended;
                Some(vec![self.result()])
            }
            Some(Err(failure)) => {
                self.state = StreamState::Ended;
                let terminated = self.notification(
                    "terminated",
                    json!({ "error": { "code": codes::INTERNAL, "message": failure.message } }),
                );
                Some(vec![terminated, self.result()])
            }
            Some(Ok(occurrence)) => {
                if let Some(cursor) = &occurrence.cursor {
                    self.last_cursor = Some(cursor.clone());
                }
                let mut params = occurrence.to_json_without_truncated();
                params["_meta"] = json!({ SUBSCRIPTION_ID_KEY: self.id });
                let event = json!({ "jsonrpc": "2.0", "method": "notifications/events/event", "params": params });
                if !occurrence.truncated {
                    return Some(vec![event]);
                }
                let mut active = json!({ "truncated": true });
                if let Some(cursor) = &occurrence.cursor {
                    active["cursor"] = json!(cursor);
                }
                Some(vec![self.notification("active", active), event])
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_age_ms_is_absent_valid_or_invalid() {
        let read = |value: Value| MaxAge::read(Some(&value)).subscribe_option();
        assert_eq!(MaxAge::read(None).subscribe_option(), None);
        assert_eq!(read(Value::Null), None);
        assert_eq!(read(json!(5000)), Some(5000.0));
        for invalid in [json!(-1), json!(1.5), json!(1e300), json!("5000")] {
            assert!(
                MaxAge::read(Some(&invalid)).is_invalid(),
                "{invalid} is invalid"
            );
        }
    }
}
