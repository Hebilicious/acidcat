# Rust binding

The language binding for Rust. It maps the [programmatic binding](programmatic.md) to async Rust on Tokio. The rules of the programmatic binding apply. This document tells only the Rust forms.

## Sessions

```rust
impl<C> Session<C> {
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

`CancellationToken` is the token of `tokio_util`. The core tells how a session opens.

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

- **Input.** `invoke` is the external call. The binding gives no typed call.
- **Outcomes.** `invoke` gives an `Outcome`. `Value` and `Failure` are the results, in their JSON form. `CallFailure` is the call failure. Each variant of `Kind` is one kind of call failure, in the order of [Call failures](../invocation.md#call-failures).
- **Availability.** `availability` gives the snapshot of the availability, or `None` for an id that is not in the view. `availability_changes` gives a message each time that the availability of a capability of the session changes, until the session closes.
- **State.** `state` gives a `StateWatch`, or `None` when the capability has no state or is not in the view. `StateWatch::snapshot` gives the snapshot in its JSON form. `StateWatch::changed` waits for the next value, and gives `false` when no more values come.
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

- **Subscribing.** `subscribe` is the external subscription. The binding gives no typed subscription. It gives `Ok` when the subscription has started, or `Err` with the call failure before the first occurrence. `options.cancel` cancels the subscription before it starts.
- **Occurrences.** Each `Some(Ok(occurrence))` of `next` is an occurrence. Its `data` is in its JSON form.
- **Ending.**

  | End | `next` |
  | --- | --- |
  | Complete | Gives `None` |
  | Cancelled | Gives `None` |
  | `internal` | Gives `Some(Err(failure))`, whose `kind` is `Internal`. After that, it gives `None` |

- **Cancellation.** `cancel` cancels the subscription, and so does dropping the `Occurrences`. To cancel while `next` waits, drop the future of `next`, for example in `tokio::select!`, then cancel or drop the `Occurrences`.
