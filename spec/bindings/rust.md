# Rust binding

The language binding for Rust. It maps the [programmatic binding](programmatic.md) to async Rust on Tokio. The rules of the programmatic binding apply. This document tells only the Rust forms.

## Sessions

```rust
impl<C: Send + Sync + 'static> Session<C> {
    pub fn open(app: &Arc<Application<C>>, target: &str, context: Arc<C>) -> Self;
    pub fn view(&self) -> &serde_json::Value;
    pub fn capability_ids(&self) -> &[String];
    pub fn event_ids(&self) -> &[String];
    pub fn availability(&self, id: &str) -> Option<Availability>;
    pub fn availability_changes(&self) -> tokio::sync::mpsc::UnboundedReceiver<()>;
    pub fn state(&self, id: &str) -> Option<StateWatch>;
    pub async fn invoke(&self, id: &str, input: serde_json::Value, cancel: &CancellationToken) -> Outcome;
    pub fn subscribe(&self, id: &str, input: serde_json::Value, options: SubscribeOptions) -> Result<Occurrences, CallFailure>;
    pub fn closing(&self) -> &CancellationToken;
    pub fn close(&self);
}
```

`CancellationToken` is the token of `tokio_util`. `C` is the type of the context that the application gives to its providers.

- **Opening.** `Session::open` opens a session for one target of the application. `Session::with_buffer_limit` also sets the number of occurrences that each subscription keeps for a client that reads slowly.
- **Handles.** A handle is the functions of the session that take the id. `capability_ids` lists the handles, and `event_ids` lists the event handles, in the order of the catalog.
- **Closing.** `close` closes the session. `closing` is cancelled when the session starts to close.

## Handles

```rust
pub enum Outcome {
    Value(serde_json::Value),
    Failure(serde_json::Value),
    CallFailure(CallFailure),
}

pub struct CallFailure {
    pub kind: Kind,
    pub message: String,
}

pub enum Kind { Cancelled, UnknownCapability, Unavailable, InvalidInput, Internal }

pub enum Availability {
    Available,
    Unavailable { reason: String },
}
```

- **Input.** `invoke` is the external call. The binding gives no typed call. A provider that panics, also before it gives its future, fails as `internal`.
- **Outcomes.** `invoke` gives an `Outcome`. `Value` and `Failure` are the results, in their JSON form. `CallFailure` is the call failure. Each variant of `Kind` is one kind of call failure, in the order of [Call failures](../invocation.md#call-failures).
- **Availability.** `availability` gives the latest availability, or `None` for an id that is not in the view. After the availability of a capability of the session changes, the receiver of `availability_changes` gets a message. One message can stand for more than one change, so read `availability` again. The receiver gives `None` when no more changes can come: the session closes, or no availability of the session can change.
- **State.** `state` gives a `StateWatch`, or `None` when the capability has no state or is not in the view. `StateWatch::snapshot` gives the snapshot in its JSON form. `StateWatch::changed` waits until the value changes, and gives `false` when no more values come. Then `snapshot` gives the latest value. Values between two reads can be lost.
- **Cancellation.** `cancel` cancels one call. Dropping the future of `invoke` also cancels the call.

## Event handles

```rust
pub struct SubscribeOptions {
    pub cursor: Option<String>,
    pub max_age_ms: Option<f64>,
    pub cancel: CancellationToken,
}

pub struct Occurrence {
    pub event_id: String,
    pub name: String,
    pub timestamp: String,
    pub data: serde_json::Value,
    pub cursor: Option<String>,
    pub truncated: bool,
}

impl Occurrences {
    pub async fn next(&mut self) -> Option<Result<Occurrence, CallFailure>>;
    pub fn cancel(&self);
}
```

- **Subscribing.** `subscribe` is the external subscription. The binding gives no typed subscription. It gives `Ok` when the subscription has started, or `Err` with the call failure before the first occurrence. A provider that panics before it gives its stream fails as `internal`. `options.cancel` cancels the subscription before it starts.
- **Occurrences.** Each `Some(Ok(occurrence))` of `next` is an occurrence. Its `data` is in its JSON form.
- **Ending.**

  | End | `next` |
  | --- | --- |
  | Complete | Gives `None` |
  | Cancelled | Gives `None` |
  | `internal` | Gives `Some(Err(failure))`, whose `kind` is `Internal`. After that, it gives `None` |

- **Cancellation.** `cancel` cancels the subscription, and so does dropping the `Occurrences`. To cancel while `next` waits, drop the future of `next`, for example in `tokio::select!`, then cancel or drop the `Occurrences`.
