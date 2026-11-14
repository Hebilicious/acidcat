#![doc = include_str!("../README.md")]

mod app;
mod event_log;
mod outcome;
mod schema;
mod session;
mod subscription;

pub use app::{
    App, Application, Call, Capability, CapabilityDefinition, Emitted, Event, EventDefinition,
    NoPayload, StateWatch, Subscription, Target,
};
pub use event_log::{EventLog, EventStore, MemoryStore, Record};
pub use outcome::{
    Availability, CallFailure, Defect, Kind, NoFailure, Outcome, RunError, RunResult, fail,
};
pub use session::{DEFAULT_BUFFER_LIMIT, Session, SubscribeOptions};
pub use subscription::{Occurrence, Occurrences};

pub mod cli;
pub mod http;
pub mod mcp;
pub mod remote;
