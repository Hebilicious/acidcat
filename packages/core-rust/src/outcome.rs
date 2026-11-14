//! Outcomes, call failures, availability and defects (spec/invocation.md).

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// The kinds of call failure, in order of precedence: when more than one applies, the first one is used
/// (spec/invocation.md#call-failures).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    Cancelled,
    UnknownCapability,
    Unavailable,
    InvalidInput,
    Internal,
}

impl Kind {
    /// The name of the kind in the JSON form, for example `unknown-capability`.
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Cancelled => "cancelled",
            Kind::UnknownCapability => "unknown-capability",
            Kind::Unavailable => "unavailable",
            Kind::InvalidInput => "invalid-input",
            Kind::Internal => "internal",
        }
    }
}

/// A call that did not give a result: `{ "kind", "message" }`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CallFailure {
    pub kind: Kind,
    pub message: String,
}

impl CallFailure {
    pub fn new(kind: Kind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub(crate) fn cancelled() -> Self {
        Self::new(Kind::Cancelled, "The call was cancelled.")
    }

    /// The JSON form of the call failure.
    pub fn to_json(&self) -> Value {
        json!({ "kind": self.kind.as_str(), "message": self.message })
    }
}

impl fmt::Display for CallFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.kind.as_str(), self.message)
    }
}

impl std::error::Error for CallFailure {}

/// The end of a call, in its JSON form: a value, a failure or a call failure (spec/invocation.md#outcomes).
#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    /// The capability did the operation. The value agrees with the output schema.
    Value(Value),
    /// The capability did not do the operation. The failure is an object with a `_tag`.
    Failure(Value),
    /// The call did not give a result.
    CallFailure(CallFailure),
}

impl Outcome {
    /// The JSON form: `{ "ok": true, "value" }`, `{ "ok": false, "error" }` or `{ "kind", "message" }`.
    pub fn to_json(&self) -> Value {
        match self {
            Outcome::Value(value) => json!({ "ok": true, "value": value }),
            Outcome::Failure(error) => json!({ "ok": false, "error": error }),
            Outcome::CallFailure(failure) => failure.to_json(),
        }
    }
}

/// If a capability can run now (spec/invocation.md#availability).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Availability {
    Available,
    Unavailable { reason: String },
}

impl Availability {
    pub fn unavailable(reason: impl Into<String>) -> Self {
        Availability::Unavailable {
            reason: reason.into(),
        }
    }

    pub fn is_available(&self) -> bool {
        matches!(self, Availability::Available)
    }

    /// The members of the JSON form: `available`, and `reason` when the capability is unavailable.
    pub(crate) fn members(&self) -> serde_json::Map<String, Value> {
        let mut members = serde_json::Map::new();
        match self {
            Availability::Available => {
                members.insert("available".into(), json!(true));
            }
            Availability::Unavailable { reason } => {
                members.insert("available".into(), json!(false));
                members.insert("reason".into(), json!(reason));
            }
        }
        members
    }
}

/// A problem in the provider, for example a bug. A call that ends with a defect gives the call failure `internal`,
/// whose message shows no internal data. The application records the full cause with `App::on_defect`.
#[derive(Debug)]
pub struct Defect(Box<dyn std::error::Error + Send + Sync>);

impl Defect {
    /// A defect with a message.
    pub fn new(message: impl Into<String>) -> Self {
        Defect(message.into().into())
    }

    pub(crate) fn from_panic(panic: Box<dyn std::any::Any + Send>) -> Self {
        let message = panic
            .downcast_ref::<&str>()
            .map(|text| (*text).to_owned())
            .or_else(|| panic.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "a panic with no message".to_owned());
        Defect::new(format!("panic: {message}"))
    }
}

impl fmt::Display for Defect {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// Each error is a defect, so that `?` works in a capability.
impl<E: std::error::Error + Send + Sync + 'static> From<E> for Defect {
    fn from(error: E) -> Self {
        Defect(Box::new(error))
    }
}

/// How a capability ends when it gives no value: a failure of the capability, or a defect.
#[derive(Debug)]
pub enum RunError<F> {
    /// A failure in the `failures` of the capability (spec/catalog.md#failures).
    Failure(F),
    /// A problem in the provider. The call ends with the call failure `internal`.
    Defect(Defect),
}

/// Each error is a defect, so that `?` works in a capability. Return a failure with [`fail`].
impl<F, E: std::error::Error + Send + Sync + 'static> From<E> for RunError<F> {
    fn from(error: E) -> Self {
        RunError::Defect(Defect::from(error))
    }
}

impl<F> From<Defect> for RunError<F> {
    fn from(defect: Defect) -> Self {
        RunError::Defect(defect)
    }
}

/// The result of a capability: its value, or a failure or a defect.
pub type RunResult<O, F> = Result<O, RunError<F>>;

/// End a capability with a failure: `return fail(Failures::Offline {})`.
pub fn fail<O, F>(failure: F) -> RunResult<O, F> {
    Err(RunError::Failure(failure))
}

/// The failures of a capability that has none. No value has this type.
#[derive(Clone, Copy, Debug)]
pub enum NoFailure {}

impl Serialize for NoFailure {
    fn serialize<S: serde::Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
        match *self {}
    }
}
