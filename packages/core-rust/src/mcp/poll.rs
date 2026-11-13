//! Poll delivery (spec/bindings/mcp.md#poll): `events/poll` reads the occurrences of a poll lease. A lease holds one
//! subscription, in a session of its own, and a buffer of its occurrences. The HTTP and the stdio transports share
//! this module.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Map, Value, json};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::{OpenSession, RpcAnswer, RpcError, codes, subscribe_error, subscription_params};
use crate::schema::canonical_json;
use crate::session::{Session, SubscribeOptions, is_max_age_ms};
use crate::subscription::Occurrence;

/// The settings of poll delivery. Each one has the default of spec/bindings/mcp.md#poll.
#[derive(Clone, Debug)]
pub struct PollOptions {
    /// The time after the last poll at which a lease ends. The default is 5 minutes.
    pub lease: Duration,
    /// The number of occurrences that each lease keeps. The default is 1000.
    pub buffer_limit: usize,
    /// The number of occurrences in a result when the request gives no `maxEvents`. The default is 100.
    pub max_events: u64,
    /// The `nextPollMs` of each result. The default is 2000.
    pub next_poll_ms: u64,
}

impl Default for PollOptions {
    fn default() -> Self {
        PollOptions {
            lease: Duration::from_secs(300),
            buffer_limit: 1000,
            max_events: 100,
            next_poll_ms: 2000,
        }
    }
}

/// One occurrence in the buffer of a lease, with its position and the last cursor of the provider at that position.
struct Entry {
    position: u64,
    occurrence: Occurrence,
    provider: Option<String>,
}

struct LeaseState {
    entries: VecDeque<Entry>,
    /// The position of the newest occurrence. The start of the lease is position 0.
    newest: u64,
    /// The cursor of the last occurrence that the provider gave, or the cursor at the start.
    last_provider: Option<String>,
    /// The message of the call failure `internal` that ended the subscription.
    failure: Option<String>,
    deadline: Instant,
}

struct Lease {
    id: String,
    key: String,
    /// The cursor of the provider at the start of the lease.
    start_provider: Option<String>,
    state: Mutex<LeaseState>,
    /// Cancelled when the lease ends. It cancels the subscription, and closes its session.
    ended: CancellationToken,
}

impl Lease {
    fn lock(&self) -> MutexGuard<'_, LeaseState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The cursor of a position of the lease.
    fn cursor_of(&self, state: &LeaseState, position: u64) -> String {
        let provider = if position == 0 {
            self.start_provider.clone()
        } else if position >= state.newest {
            state.last_provider.clone()
        } else {
            state
                .entries
                .iter()
                .find(|entry| entry.position == position)
                .and_then(|entry| entry.provider.clone())
        };
        encode_cursor(&self.id, position, provider.as_deref())
    }
}

/// The poll leases of one server. [`PollLeases::close`] ends them all.
pub(crate) struct PollLeases {
    options: PollOptions,
    leases: Mutex<HashMap<String, Arc<Lease>>>,
    closed: CancellationToken,
}

impl PollLeases {
    pub(crate) fn new(options: PollOptions) -> Arc<Self> {
        Arc::new(PollLeases {
            options,
            leases: Mutex::new(HashMap::new()),
            closed: CancellationToken::new(),
        })
    }

    fn leases(&self) -> MutexGuard<'_, HashMap<String, Arc<Lease>>> {
        self.leases
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// End all leases.
    pub(crate) fn close(&self) {
        self.closed.cancel();
        let leases: Vec<Arc<Lease>> = self.leases().drain().map(|(_, lease)| lease).collect();
        for lease in leases {
            lease.ended.cancel();
        }
    }

    fn end(&self, lease: &Arc<Lease>) {
        lease.ended.cancel();
        let mut leases = self.leases();
        if leases
            .get(&lease.key)
            .is_some_and(|current| Arc::ptr_eq(current, lease))
        {
            leases.remove(&lease.key);
        }
    }

    /// Answer `events/poll`. `principal` is the identity of the client, or `None`. `open` opens the session of a new
    /// lease.
    pub(crate) fn poll<C: Send + Sync + 'static>(
        self: &Arc<Self>,
        principal: Option<&str>,
        params: &Map<String, Value>,
        open: &OpenSession<C>,
    ) -> RpcAnswer {
        let read = subscription_params(params)?;
        let max_events = match params.get("maxEvents") {
            None => self.options.max_events,
            Some(value) => match value.as_u64() {
                Some(count)
                    if count >= 1 && value.as_f64().is_some_and(|number| number.fract() == 0.0) =>
                {
                    count
                }
                _ => {
                    return Err(RpcError::invalid_params(
                        "maxEvents must be a positive integer.",
                    ));
                }
            },
        };
        let key = canonical_json(&json!([principal, read.name, read.input]));
        let lease = self.leases().get(&key).cloned();

        if let Some(lease) = &lease {
            let failure = lease.lock().failure.clone();
            if let Some(message) = failure {
                self.end(lease);
                return Err(RpcError::new(codes::INTERNAL, message));
            }
        }
        let position = read.cursor.as_deref().and_then(decode_cursor);

        let Some(lease) = lease else {
            // A cursor that is not of a lease that exists: resume after the cursor of the provider, if it has one.
            let provider = position.and_then(|(_, _, provider)| provider);
            // With no cursor of the provider, a valid maxAgeMs changes nothing. The session still rejects one that is not valid.
            let max_age_ms = if provider.is_none() && read.max_age_ms.is_none_or(is_max_age_ms) {
                None
            } else {
                read.max_age_ms
            };
            let lease = self.start(key, &read.name, read.input, provider, max_age_ms, open)?;
            let state = lease.lock();
            return Ok(self.result(
                Vec::new(),
                lease.cursor_of(&state, 0),
                read.cursor.is_some() && lease.start_provider.is_none(),
                false,
            ));
        };

        // A lease with this key exists, so the event exists: an invalid maxAgeMs is the next failure that applies.
        if read.max_age_ms.is_some_and(|value| !is_max_age_ms(value)) {
            return Err(RpcError::invalid_params(
                "maxAgeMs must be an integer that is 0 or more.",
            ));
        }
        let mut state = lease.lock();
        state.deadline = Instant::now() + self.options.lease;
        let Some(request_cursor) = read.cursor else {
            let cursor = lease.cursor_of(&state, state.newest);
            return Ok(self.result(Vec::new(), cursor, false, false));
        };
        match position {
            Some((id, after, _)) if id == lease.id => {
                let oldest = state
                    .entries
                    .front()
                    .map_or(state.newest + 1, |entry| entry.position);
                let older = after + 1 < oldest;
                let available: Vec<&Entry> = state
                    .entries
                    .iter()
                    .filter(|entry| entry.position > after)
                    .collect();
                let has_more = available.len() as u64 > max_events;
                let events: Vec<&Entry> = available.into_iter().take(max_events as usize).collect();
                let truncated = older || events.iter().any(|entry| entry.occurrence.truncated);
                let cursor = events.last().map_or(request_cursor, |last| {
                    lease.cursor_of(&state, last.position)
                });
                let events = events
                    .iter()
                    .map(|entry| entry.occurrence.to_json_without_truncated())
                    .collect();
                Ok(self.result(events, cursor, truncated, has_more))
            }
            // A cursor of another lease, while a lease with this key exists: the newest position, and the client can
            // have missed occurrences.
            _ => {
                let cursor = lease.cursor_of(&state, state.newest);
                Ok(self.result(Vec::new(), cursor, true, false))
            }
        }
    }

    /// Start a lease: open its session, subscribe, and keep the occurrences. A failure before the first occurrence
    /// starts no lease.
    fn start<C: Send + Sync + 'static>(
        self: &Arc<Self>,
        key: String,
        name: &str,
        input: Value,
        provider: Option<String>,
        max_age_ms: Option<f64>,
        open: &OpenSession<C>,
    ) -> Result<Arc<Lease>, RpcError> {
        let session: Session<C> = open();
        let subscribed = session.subscribe(
            name,
            input,
            SubscribeOptions {
                cursor: provider.clone(),
                max_age_ms,
                cancel: CancellationToken::new(),
            },
        );
        let mut occurrences = match subscribed {
            Ok(occurrences) => occurrences,
            Err(failure) => {
                session.close();
                return Err(subscribe_error(&failure));
            }
        };
        if self.closed.is_cancelled() {
            session.close();
            return Err(RpcError::new(codes::INTERNAL, "The server is closing."));
        }
        let lease = Arc::new(Lease {
            id: uuid::Uuid::new_v4().to_string(),
            key: key.clone(),
            start_provider: provider.clone(),
            state: Mutex::new(LeaseState {
                entries: VecDeque::new(),
                newest: 0,
                last_provider: provider,
                failure: None,
                deadline: Instant::now() + self.options.lease,
            }),
            ended: CancellationToken::new(),
        });
        self.leases().insert(key, lease.clone());

        // Read the occurrences into the buffer until the subscription ends. The lease keeps its buffer until it ends.
        let reading = lease.clone();
        let limit = self.options.buffer_limit.max(1);
        tokio::spawn(async move {
            loop {
                let next = tokio::select! {
                    () = reading.ended.cancelled() => break,
                    next = occurrences.next() => next,
                };
                let mut state = reading.lock();
                match next {
                    None => break,
                    Some(Err(failure)) => {
                        state.failure = Some(failure.message);
                        break;
                    }
                    Some(Ok(occurrence)) => {
                        if let Some(cursor) = &occurrence.cursor {
                            state.last_provider = Some(cursor.clone());
                        }
                        state.newest += 1;
                        let entry = Entry {
                            position: state.newest,
                            occurrence,
                            provider: state.last_provider.clone(),
                        };
                        state.entries.push_back(entry);
                        if state.entries.len() > limit {
                            state.entries.pop_front();
                        }
                    }
                }
            }
            drop(occurrences);
            session.close();
        });

        // End the lease when it gets no poll for the lease time.
        let leases = self.clone();
        let timed = lease.clone();
        tokio::spawn(async move {
            loop {
                let deadline = timed.lock().deadline;
                tokio::select! {
                    () = timed.ended.cancelled() => return,
                    () = tokio::time::sleep_until(deadline) => {}
                }
                if timed.lock().deadline <= Instant::now() {
                    leases.end(&timed);
                    return;
                }
            }
        });
        Ok(lease)
    }

    fn result(
        &self,
        events: Vec<Value>,
        cursor: String,
        truncated: bool,
        has_more: bool,
    ) -> Map<String, Value> {
        let mut result = Map::new();
        result.insert("events".into(), Value::Array(events));
        result.insert("cursor".into(), json!(cursor));
        result.insert("truncated".into(), json!(truncated));
        result.insert("hasMore".into(), json!(has_more));
        result.insert("nextPollMs".into(), json!(self.options.next_poll_ms));
        result
    }
}

/// The cursor of a poll position. Only the server reads it.
fn encode_cursor(lease: &str, position: u64, provider: Option<&str>) -> String {
    let parts = match provider {
        Some(provider) => json!([lease, position, provider]),
        None => json!([lease, position]),
    };
    format!("p1.{}", URL_SAFE_NO_PAD.encode(parts.to_string()))
}

/// The lease, the position and the cursor of the provider of a poll cursor, or `None` when the text is not one.
fn decode_cursor(cursor: &str) -> Option<(String, u64, Option<String>)> {
    let bytes = URL_SAFE_NO_PAD.decode(cursor.strip_prefix("p1.")?).ok()?;
    let parts: Vec<Value> = serde_json::from_slice(&bytes).ok()?;
    let lease = parts.first()?.as_str()?.to_owned();
    let position = parts.get(1)?.as_u64()?;
    let provider = match parts.get(2) {
        None => None,
        Some(provider) => Some(provider.as_str()?.to_owned()),
    };
    (parts.len() <= 3).then_some((lease, position, provider))
}
