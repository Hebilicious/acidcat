//! One subscription (spec/events.md): the task that reads the occurrences of the provider, the bounded buffer for a
//! slow client, and the handle that the client reads.

use std::collections::VecDeque;
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex, MutexGuard};

use futures::FutureExt;
use futures::stream::{BoxStream, StreamExt};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::app::ErasedEmitted;
use crate::outcome::{CallFailure, Defect, Kind};

/// One thing that happened, in its JSON form (spec/events.md#occurrences).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Occurrence {
    pub event_id: String,
    pub name: String,
    pub timestamp: String,
    pub data: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

impl Occurrence {
    /// The JSON form of the occurrence.
    pub fn to_json(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }

    /// The JSON form of the occurrence without `truncated`, as the MCP binding sends it.
    pub fn to_json_without_truncated(&self) -> Value {
        let mut json = self.to_json();
        if let Some(object) = json.as_object_mut() {
            object.remove("truncated");
        }
        json
    }
}

/// The message of the call failure `internal` of a subscription. It shows no internal data.
pub(crate) const INTERNAL_MESSAGE: &str = "The event failed.";

struct State {
    buffer: VecDeque<Occurrence>,
    /// True when the buffer removed occurrences: the next occurrence that the client reads has `truncated: true`.
    dropped: bool,
    /// How the provider ended: complete (`None`) or with a call failure. The client still reads the buffer first.
    ending: Option<Option<CallFailure>>,
    /// True when the client sees only the end.
    closed: bool,
}

struct Shared {
    state: Mutex<State>,
    notify: Notify,
    /// Cancelled when the subscription ends in any way. It stops the provider.
    stop: CancellationToken,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn end(&self, how: Option<CallFailure>) {
        {
            let mut state = self.lock();
            if state.ending.is_none() && !state.closed {
                state.ending = Some(how);
            }
        }
        self.stop.cancel();
        self.notify.notify_waiters();
    }

    fn push(&self, occurrence: Occurrence, limit: usize) {
        {
            let mut state = self.lock();
            state.buffer.push_back(occurrence);
            if state.buffer.len() > limit {
                state.buffer.pop_front();
                state.dropped = true;
            }
        }
        self.notify.notify_waiters();
    }
}

/// The occurrences of one subscription. [`Occurrences::next`] gives each occurrence, then the end. Dropping the
/// handle, or [`Occurrences::cancel`], cancels the subscription.
pub struct Occurrences {
    shared: Arc<Shared>,
}

impl Occurrences {
    /// The next occurrence, or the call failure that ended the subscription, or `None` at the end.
    pub async fn next(&mut self) -> Option<Result<Occurrence, CallFailure>> {
        loop {
            let notified = self.shared.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let mut state = self.shared.lock();
                if state.closed {
                    return None;
                }
                if let Some(mut occurrence) = state.buffer.pop_front() {
                    if state.dropped {
                        state.dropped = false;
                        occurrence.truncated = true;
                    }
                    return Some(Ok(occurrence));
                }
                if let Some(ending) = state.ending.take() {
                    state.closed = true;
                    return ending.map(Err);
                }
            }
            notified.await;
        }
    }

    /// Cancel the subscription: the client sees the end at once.
    pub fn cancel(&self) {
        {
            let mut state = self.shared.lock();
            state.closed = true;
            state.buffer.clear();
        }
        self.shared.stop.cancel();
        self.shared.notify.notify_waiters();
    }

    /// The occurrences as a stream. The stream ends after the end of the subscription.
    pub fn into_stream(self) -> BoxStream<'static, Result<Occurrence, CallFailure>> {
        futures::stream::unfold(self, |mut occurrences| async move {
            occurrences.next().await.map(|item| (item, occurrences))
        })
        .boxed()
    }
}

impl Drop for Occurrences {
    fn drop(&mut self) {
        self.cancel();
    }
}

/// Checks the data of one occurrence against the payload schema. The result is the problem, if any.
pub(crate) type PayloadCheck = Box<dyn Fn(&Value) -> Option<String> + Send + Sync>;

/// The parts of a subscription that starts.
pub(crate) struct Parts {
    pub(crate) name: String,
    pub(crate) source: BoxStream<'static, Result<ErasedEmitted, Defect>>,
    /// Check the data of one occurrence against the payload schema. The result is the problem, if any.
    pub(crate) check: PayloadCheck,
    pub(crate) limit: usize,
    /// Cancelled when the session closes. The subscription then ends as complete.
    pub(crate) closing: CancellationToken,
    pub(crate) on_defect: Box<dyn Fn(&Defect) + Send + Sync>,
}

/// The token that the provider gets, and the function that starts the task of the subscription.
pub(crate) fn prepare() -> (CancellationToken, impl FnOnce(Parts) -> Occurrences) {
    let stop = CancellationToken::new();
    let token = stop.clone();
    let start = move |parts: Parts| {
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                buffer: VecDeque::new(),
                dropped: false,
                ending: None,
                closed: false,
            }),
            notify: Notify::new(),
            stop,
        });
        tokio::spawn(pump(shared.clone(), parts));
        Occurrences { shared }
    };
    (token, start)
}

/// Read the occurrences of the provider into the buffer, until the subscription ends.
async fn pump(shared: Arc<Shared>, parts: Parts) {
    let Parts {
        name,
        mut source,
        check,
        limit,
        closing,
        on_defect,
    } = parts;
    let fail = |defect: Defect| {
        on_defect(&defect);
        shared.end(Some(CallFailure::new(Kind::Internal, INTERNAL_MESSAGE)));
    };
    loop {
        let item = tokio::select! {
            biased;
            () = shared.stop.cancelled() => return,
            () = closing.cancelled() => return shared.end(None),
            item = AssertUnwindSafe(source.next()).catch_unwind() => item,
        };
        let emitted = match item {
            Err(panic) => return fail(Defect::from_panic(panic)),
            Ok(None) => return shared.end(None),
            Ok(Some(Err(defect))) => return fail(defect),
            Ok(Some(Ok(emitted))) => emitted,
        };
        if emitted.event_id.as_deref() == Some("") {
            return fail(Defect::new("The eventId of an occurrence is empty."));
        }
        if let Some(problem) = check(&emitted.data) {
            return fail(Defect::new(format!(
                "The data of an occurrence does not agree with the payload schema: {problem}"
            )));
        }
        let occurrence = Occurrence {
            event_id: emitted
                .event_id
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            name: name.clone(),
            timestamp: emitted.timestamp.unwrap_or_else(|| {
                humantime::format_rfc3339_millis(std::time::SystemTime::now()).to_string()
            }),
            data: emitted.data,
            cursor: emitted.cursor,
            truncated: emitted.truncated,
        };
        shared.push(occurrence, limit);
    }
}
