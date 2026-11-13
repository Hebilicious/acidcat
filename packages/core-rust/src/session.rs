//! Sessions (spec/invocation.md#sessions): one client calls the capabilities of one target, and follows its events.

use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use futures::FutureExt;
use serde_json::Value;
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;

use crate::app::{Application, ServedCapability, ServedEvent, call, subscription};
use crate::outcome::{Availability, CallFailure, Defect, Kind, Outcome};
use crate::subscription::{Occurrences, Parts, prepare};

/// The number of occurrences that each subscription keeps for a client that reads slowly, if the binding gives no
/// limit (spec/events.md#slow-clients).
pub const DEFAULT_BUFFER_LIMIT: usize = 256;

/// Where a subscription starts, and how the client cancels it (spec/events.md#resuming).
#[derive(Clone, Debug, Default)]
pub struct SubscribeOptions {
    /// Start after this position.
    pub cursor: Option<String>,
    /// Send no occurrence that is older than this number of milliseconds. A value that is not an integer that is 0
    /// or more, for example `NaN`, fails as `invalid-input`.
    pub max_age_ms: Option<f64>,
    /// Cancels the subscription before it starts.
    pub cancel: CancellationToken,
}

/// True if `maxAgeMs` is an integer that is 0 or more.
pub(crate) fn is_max_age_ms(value: f64) -> bool {
    value.is_finite() && value >= 0.0 && value.fract() == 0.0 && value <= 9_007_199_254_740_991.0
}

struct Served<C> {
    capability: Arc<ServedCapability<C>>,
    availability: Option<watch::Receiver<Availability>>,
}

struct Inner<C> {
    app: Arc<Application<C>>,
    target: String,
    context: Arc<C>,
    view: Arc<Value>,
    closing: CancellationToken,
    capabilities: HashMap<String, Served<C>>,
    events: HashMap<String, Arc<ServedEvent<C>>>,
    capability_ids: Vec<String>,
    event_ids: Vec<String>,
    buffer_limit: usize,
}

/// A session. Clones share the session. [`Session::close`] closes it.
pub struct Session<C> {
    inner: Arc<Inner<C>>,
}

impl<C> Clone for Session<C> {
    fn clone(&self) -> Self {
        Session { inner: self.inner.clone() }
    }
}

impl<C: Send + Sync + 'static> Session<C> {
    /// Open a session for a target, with the services of the application.
    pub fn open(app: &Arc<Application<C>>, target: &str, context: Arc<C>) -> Self {
        Self::with_buffer_limit(app, target, context, DEFAULT_BUFFER_LIMIT)
    }

    /// Open a session whose subscriptions each keep at most `buffer_limit` occurrences for a client that reads slowly.
    pub fn with_buffer_limit(app: &Arc<Application<C>>, target: &str, context: Arc<C>, buffer_limit: usize) -> Self {
        let mut capabilities = HashMap::new();
        let mut capability_ids = Vec::new();
        for capability in &app.capabilities {
            if !capability.definition.audience.iter().any(|name| name == target) {
                continue;
            }
            let availability = capability.definition.availability.as_ref().map(|source| source(&context));
            capability_ids.push(capability.definition.id.clone());
            capabilities.insert(capability.definition.id.clone(), Served { capability: capability.clone(), availability });
        }
        let mut events = HashMap::new();
        let mut event_ids = Vec::new();
        for event in &app.events {
            if event.definition.audience.iter().any(|name| name == target) {
                event_ids.push(event.definition.id.clone());
                events.insert(event.definition.id.clone(), event.clone());
            }
        }
        Session {
            inner: Arc::new(Inner {
                view: app.view(target),
                app: app.clone(),
                target: target.to_owned(),
                context,
                closing: CancellationToken::new(),
                capabilities,
                events,
                capability_ids,
                event_ids,
                buffer_limit: buffer_limit.max(1),
            }),
        }
    }

    pub fn target(&self) -> &str {
        &self.inner.target
    }

    /// The view of the target. Bindings take names, descriptions and schemas from it.
    pub fn view(&self) -> &Value {
        &self.inner.view
    }

    pub fn application(&self) -> &Arc<Application<C>> {
        &self.inner.app
    }

    /// The ids of the capabilities in the view, in the order of the catalog.
    pub fn capability_ids(&self) -> &[String] {
        &self.inner.capability_ids
    }

    /// The ids of the events in the view, in the order of the catalog.
    pub fn event_ids(&self) -> &[String] {
        &self.inner.event_ids
    }

    pub fn has_event(&self, id: &str) -> bool {
        self.inner.events.contains_key(id)
    }

    /// The availability of a capability now, or `None` when it is not in the view.
    pub fn availability(&self, id: &str) -> Option<Availability> {
        let served = self.inner.capabilities.get(id)?;
        Some(served.availability.as_ref().map_or(Availability::Available, |receiver| receiver.borrow().clone()))
    }

    /// The token that is cancelled when the session starts to close.
    pub fn closing(&self) -> &CancellationToken {
        &self.inner.closing
    }

    /// Close the session: accept no new calls and subscriptions, cancel the calls in progress, and end each
    /// subscription as complete.
    pub fn close(&self) {
        self.inner.closing.cancel();
    }

    /// A message each time that the availability of a capability changes, until the session closes.
    pub fn availability_changes(&self) -> mpsc::UnboundedReceiver<()> {
        let (sender, receiver) = mpsc::unbounded_channel();
        for served in self.inner.capabilities.values() {
            let Some(mut availability) = served.availability.clone() else { continue };
            let sender = sender.clone();
            let closing = self.inner.closing.clone();
            tokio::spawn(async move {
                loop {
                    tokio::select! {
                        () = closing.cancelled() => return,
                        changed = availability.changed() => {
                            if changed.is_err() || sender.send(()).is_err() {
                                return;
                            }
                        }
                    }
                }
            });
        }
        receiver
    }

    /// A call with an input that is not trusted. The outcome is in its JSON form. `cancel` cancels the call. When
    /// the future is dropped, the call is cancelled too.
    pub async fn invoke(&self, id: &str, input: Value, cancel: &CancellationToken) -> Outcome {
        let inner = &self.inner;
        if inner.closing.is_cancelled() || cancel.is_cancelled() {
            return Outcome::CallFailure(CallFailure::cancelled());
        }
        let Some(served) = inner.capabilities.get(id) else {
            return Outcome::CallFailure(CallFailure::new(Kind::UnknownCapability, format!("There is no capability {id}.")));
        };
        if let Some(Availability::Unavailable { reason }) = self.availability(id) {
            return Outcome::CallFailure(CallFailure::new(Kind::Unavailable, reason));
        }
        let capability = &served.capability;
        if let Some(issues) = capability.input.as_ref().and_then(|validator| validator.issues(&input)) {
            return Outcome::CallFailure(CallFailure::new(Kind::InvalidInput, issues));
        }
        let token = inner.closing.child_token();
        let _cancel_on_end = token.clone().drop_guard();
        let work = match (capability.definition.run)(input, call(inner.context.clone(), token.clone())) {
            Ok(work) => work,
            Err(message) => return Outcome::CallFailure(CallFailure::new(Kind::InvalidInput, message)),
        };
        let ended = tokio::select! {
            biased;
            () = token.cancelled() => return Outcome::CallFailure(CallFailure::cancelled()),
            () = cancel.cancelled() => return Outcome::CallFailure(CallFailure::cancelled()),
            ended = AssertUnwindSafe(work).catch_unwind() => ended,
        };
        let checked = match ended {
            Err(panic) => Err(Defect::from_panic(panic)),
            Ok(Err(defect)) => Err(defect),
            Ok(Ok(Ok(value))) => match capability.output.as_ref().and_then(|validator| validator.issues(&value)) {
                Some(issues) => Err(Defect::new(format!("The output does not agree with its schema: {issues}"))),
                None => Ok(Outcome::Value(value)),
            },
            Ok(Ok(Err(failure))) => {
                let tag = failure.get("_tag").and_then(Value::as_str).unwrap_or_default();
                match capability.failures.get(tag) {
                    None => Err(Defect::new(format!("The failure {tag} is not in failures."))),
                    Some(validator) => match validator.issues(&failure) {
                        Some(issues) => Err(Defect::new(format!("The failure {tag} does not agree with its schema: {issues}"))),
                        None => Ok(Outcome::Failure(failure)),
                    },
                }
            }
        };
        checked.unwrap_or_else(|defect| {
            inner.app.defect(id, &defect);
            Outcome::CallFailure(CallFailure::new(Kind::Internal, "The capability failed."))
        })
    }

    /// A subscription with an input that is not trusted. The result is the occurrences, or the call failure before
    /// the first occurrence (spec/events.md#subscribing).
    pub fn subscribe(&self, id: &str, input: Value, options: SubscribeOptions) -> Result<Occurrences, CallFailure> {
        let inner = &self.inner;
        let cancelled = || CallFailure::new(Kind::Cancelled, "The subscription was cancelled.");
        if inner.closing.is_cancelled() || options.cancel.is_cancelled() {
            return Err(cancelled());
        }
        let Some(event) = inner.events.get(id) else {
            return Err(CallFailure::new(Kind::UnknownCapability, format!("There is no event {id}.")));
        };
        let max_age_ms = match options.max_age_ms {
            Some(value) if !is_max_age_ms(value) => return Err(CallFailure::new(Kind::InvalidInput, "maxAgeMs must be an integer that is 0 or more.")),
            Some(value) => Some(value as u64),
            None => None,
        };
        if let Some(issues) = event.input.as_ref().and_then(|validator| validator.issues(&input)) {
            return Err(CallFailure::new(Kind::InvalidInput, issues));
        }
        let (token, start) = prepare();
        let source = (event.definition.subscribe)(input, subscription(inner.context.clone(), options.cursor, max_age_ms, token))
            .map_err(|message| CallFailure::new(Kind::InvalidInput, message))?;
        let checked = event.clone();
        let app = inner.app.clone();
        let name = id.to_owned();
        Ok(start(Parts {
            name: id.to_owned(),
            source,
            check: Box::new(move |data: &Value| match &checked.payload {
                Some(validator) => validator.issues(data),
                None if data.as_object().is_some_and(serde_json::Map::is_empty) => None,
                None => Some("the event has no payload schema, so the data must be an empty object".to_owned()),
            }),
            limit: inner.buffer_limit,
            closing: inner.closing.clone(),
            on_defect: Box::new(move |defect| app.defect(&name, defect)),
        }))
    }
}
