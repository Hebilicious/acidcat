//! The AcidCat core for Rust: serve the capabilities and the events of an application through the MCP, HTTP and CLI
//! bindings (spec/bindings/README.md).

mod app;
mod outcome;
mod schema;
mod session;
mod subscription;

pub use app::{App, Application, Call, Capability, CapabilityDefinition, Emitted, Event, EventDefinition, NoPayload, Subscription};
pub use outcome::{Availability, CallFailure, Defect, Kind, NoFailure, Outcome, RunError, RunResult, fail};
pub use session::{DEFAULT_BUFFER_LIMIT, Session, SubscribeOptions};
pub use subscription::{Occurrence, Occurrences};

pub mod http;
pub mod remote;
pub mod mcp;
pub mod cli;
