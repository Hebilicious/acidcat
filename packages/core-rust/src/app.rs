//! The application: its targets, capabilities and events, and the catalog that its code writes (spec/catalog.md).

use std::collections::HashMap;
use std::future::Future;
use std::marker::PhantomData;
use std::sync::Arc;

use acid_cat_catalog as catalog;
pub use acid_cat_catalog::Target;
use futures::future::BoxFuture;
use futures::stream::{BoxStream, Stream, StreamExt};
use schemars::JsonSchema;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::outcome::{Availability, Defect, NoFailure, RunError, RunResult};
use crate::schema::{Validator, schema_of, view_of};

/// What a capability gets for one call: the services of the application, and the signal of the call.
pub struct Call<C> {
    context: Arc<C>,
    cancel: CancellationToken,
}

impl<C> Call<C> {
    /// The services of the application.
    pub fn context(&self) -> &C {
        &self.context
    }

    /// The services of the application, to move into a task.
    pub fn context_arc(&self) -> Arc<C> {
        self.context.clone()
    }

    /// The token that is cancelled when the call is cancelled. The core also drops the future of a cancelled call.
    pub fn cancel_token(&self) -> &CancellationToken {
        &self.cancel
    }
}

/// What an event gets for one subscription: the services of the application, where the subscription starts, and the
/// signal of the subscription (spec/events.md#resuming).
pub struct Subscription<C> {
    context: Arc<C>,
    cursor: Option<String>,
    max_age_ms: Option<u64>,
    cancel: CancellationToken,
}

impl<C> Subscription<C> {
    pub fn context(&self) -> &C {
        &self.context
    }

    pub fn context_arc(&self) -> Arc<C> {
        self.context.clone()
    }

    /// The cursor of the client. Start after this position.
    pub fn cursor(&self) -> Option<&str> {
        self.cursor.as_deref()
    }

    /// Send no occurrence that is older than this number of milliseconds.
    pub fn max_age_ms(&self) -> Option<u64> {
        self.max_age_ms
    }

    /// The token that is cancelled when the subscription ends. The core also drops the stream then.
    pub fn cancel_token(&self) -> &CancellationToken {
        &self.cancel
    }
}

/// One occurrence that a provider gives. The binding adds the `name`, and makes the `eventId` and the `timestamp` if
/// the provider gives none (spec/events.md#occurrences).
#[derive(Clone, Debug)]
pub struct Emitted<P> {
    pub data: P,
    pub event_id: Option<String>,
    pub timestamp: Option<String>,
    pub cursor: Option<String>,
    pub truncated: bool,
}

impl<P> Emitted<P> {
    pub fn new(data: P) -> Self {
        Self {
            data,
            event_id: None,
            timestamp: None,
            cursor: None,
            truncated: false,
        }
    }

    /// The id of the thing that happened, from its source.
    pub fn event_id(mut self, event_id: impl Into<String>) -> Self {
        self.event_id = Some(event_id.into());
        self
    }

    /// When the thing happened, as an RFC 3339 date and time in UTC.
    pub fn timestamp(mut self, timestamp: impl Into<String>) -> Self {
        self.timestamp = Some(timestamp.into());
        self
    }

    /// The position of the subscription after this occurrence.
    pub fn cursor(mut self, cursor: impl Into<String>) -> Self {
        self.cursor = Some(cursor.into());
        self
    }

    /// The provider skipped occurrences before this one.
    pub fn truncated(mut self) -> Self {
        self.truncated = true;
        self
    }
}

/// The data of an occurrence of an event that has no payload schema: an empty object.
#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct NoPayload {}

type AvailabilityFn<C> = Arc<dyn Fn(&C) -> watch::Receiver<Availability> + Send + Sync>;

/// The state of a capability in a session, with its type erased.
pub(crate) trait StateSource: Send + Sync {
    fn snapshot(&self) -> Value;
    fn changed(&mut self) -> BoxFuture<'_, bool>;
}

impl<T: Serialize + Send + Sync + 'static> StateSource for watch::Receiver<T> {
    fn snapshot(&self) -> Value {
        serde_json::to_value(&*self.borrow()).unwrap_or(Value::Null)
    }

    fn changed(&mut self) -> BoxFuture<'_, bool> {
        Box::pin(async move { watch::Receiver::changed(self).await.is_ok() })
    }
}

pub(crate) type StateFn<C> = Arc<dyn Fn(&C) -> Box<dyn StateSource> + Send + Sync>;

/// The state of a capability that a client observes (spec/invocation.md#state). Each value is a copy in its JSON form.
pub struct StateWatch(Box<dyn StateSource>);

impl StateWatch {
    pub(crate) fn new(source: Box<dyn StateSource>) -> Self {
        StateWatch(source)
    }

    /// The value now.
    pub fn snapshot(&self) -> Value {
        self.0.snapshot()
    }

    /// Wait for the next change. The result is `false` when the source has no more changes.
    pub async fn changed(&mut self) -> bool {
        self.0.changed().await
    }
}

/// The work of a capability on an input in its JSON form: the input is not valid (the message), or the future of the
/// work, which gives a value or a failure in their JSON forms.
pub(crate) type ErasedRun<C> = Arc<
    dyn Fn(
            Value,
            Call<C>,
        ) -> Result<BoxFuture<'static, Result<Result<Value, Value>, Defect>>, String>
        + Send
        + Sync,
>;

pub(crate) type ErasedEmitted = Emitted<Value>;

/// The provider of an event on an input in its JSON form: the input is not valid (the message), or the stream of
/// occurrences.
pub(crate) type ErasedSubscribe<C> = Arc<
    dyn Fn(
            Value,
            Subscription<C>,
        ) -> Result<BoxStream<'static, Result<ErasedEmitted, Defect>>, String>
        + Send
        + Sync,
>;

/// A capability that is being declared. `I`, `O` and `F` are the types of the input, the value and the failures.
/// Finish it with [`Capability::run`].
pub struct Capability<C, I = (), O = (), F = NoFailure> {
    id: String,
    description: String,
    audience: Vec<String>,
    read_only: bool,
    input: Option<Value>,
    output: Option<Value>,
    failures: Vec<(String, Value)>,
    types: Map<String, Value>,
    problems: Vec<String>,
    availability: Option<AvailabilityFn<C>>,
    state: Option<(Value, StateFn<C>)>,
    marker: PhantomData<fn(I) -> (O, F)>,
}

impl<C> Capability<C> {
    /// Start a capability with no input, no output and no failures.
    pub fn new(id: impl Into<String>, description: impl Into<String>) -> Self {
        Capability {
            id: id.into(),
            description: description.into(),
            audience: Vec::new(),
            read_only: false,
            input: None,
            output: None,
            failures: Vec::new(),
            types: Map::new(),
            problems: Vec::new(),
            availability: None,
            state: None,
            marker: PhantomData,
        }
    }
}

impl<C, I, O, F> Capability<C, I, O, F> {
    fn retype<I2, O2, F2>(self) -> Capability<C, I2, O2, F2> {
        Capability {
            id: self.id,
            description: self.description,
            audience: self.audience,
            read_only: self.read_only,
            input: self.input,
            output: self.output,
            failures: self.failures,
            types: self.types,
            problems: self.problems,
            availability: self.availability,
            state: self.state,
            marker: PhantomData,
        }
    }

    fn add_types(&mut self, types: Map<String, Value>) {
        for (name, schema) in types {
            if let Some(existing) = self.types.get(&name)
                && *existing != schema
            {
                self.problems
                    .push(format!("the type {name} has two different schemas"));
            }
            self.types.insert(name, schema);
        }
    }

    /// The targets that can use the capability.
    pub fn audience<S: Into<String>>(mut self, targets: impl IntoIterator<Item = S>) -> Self {
        self.audience = targets.into_iter().map(Into::into).collect();
        self
    }

    /// A call changes nothing that a client can see.
    pub fn read_only(mut self) -> Self {
        self.read_only = true;
        self
    }

    /// The availability of the capability in each session, from the services of the application.
    pub fn availability(
        mut self,
        availability: impl Fn(&C) -> watch::Receiver<Availability> + Send + Sync + 'static,
    ) -> Self {
        self.availability = Some(Arc::new(availability));
        self
    }

    /// The state of the capability: a value that clients can observe, from the services of the application. Its type
    /// gives the state schema.
    pub fn state<T: JsonSchema + Serialize + Send + Sync + 'static>(
        mut self,
        source: impl Fn(&C) -> watch::Receiver<T> + Send + Sync + 'static,
    ) -> Self {
        let (schema, types) = schema_of::<T>();
        self.add_types(types);
        let source: StateFn<C> = Arc::new(move |context: &C| Box::new(source(context)));
        self.state = Some((schema, source));
        self
    }

    /// The input type. Its schema is the input schema of the capability.
    pub fn input<T: JsonSchema + DeserializeOwned>(mut self) -> Capability<C, T, O, F> {
        let (schema, types) = schema_of::<T>();
        self.input = Some(schema);
        self.add_types(types);
        self.retype()
    }

    /// The input type, with a schema that you write. The schema can refer to the types of [`App::types`].
    pub fn input_schema<T: DeserializeOwned>(mut self, schema: Value) -> Capability<C, T, O, F> {
        self.input = Some(schema);
        self.retype()
    }

    /// The type of the value. Its schema is the output schema of the capability.
    pub fn output<T: JsonSchema + Serialize>(mut self) -> Capability<C, I, T, F> {
        let (schema, types) = schema_of::<T>();
        self.output = Some(schema);
        self.add_types(types);
        self.retype()
    }

    /// The type of the value, with a schema that you write.
    pub fn output_schema<T: Serialize>(mut self, schema: Value) -> Capability<C, I, T, F> {
        self.output = Some(schema);
        self.retype()
    }

    /// The failures: an enum with `#[serde(tag = "_tag")]`. Each variant is one failure, and its name is the tag.
    pub fn failures<T: JsonSchema + Serialize>(mut self) -> Capability<C, I, O, T> {
        let (schema, types) = schema_of::<T>();
        self.add_types(types);
        match failures_of(&schema) {
            Ok(failures) => self.failures = failures,
            Err(problem) => self
                .problems
                .push(format!("the failures of {}: {problem}", self.id)),
        }
        self.retype()
    }

    /// The failures, with a schema that you write for each tag. Each value of `T` is an object with its tag in `_tag`.
    pub fn failure_schemas<T: Serialize, S: Into<String>>(
        mut self,
        failures: impl IntoIterator<Item = (S, Value)>,
    ) -> Capability<C, I, O, T> {
        self.failures = failures
            .into_iter()
            .map(|(tag, schema)| (tag.into(), schema))
            .collect();
        self.retype()
    }
}

impl<C, I, O, F> Capability<C, I, O, F>
where
    C: Send + Sync + 'static,
    I: DeserializeOwned + Send + 'static,
    O: Serialize + Send + 'static,
    F: Serialize + Send + 'static,
{
    /// The work of the capability. The future gives the value, a failure (with [`crate::fail`]) or a defect. When
    /// the call is cancelled, the core drops the future.
    pub fn run<Run, Work>(self, run: Run) -> CapabilityDefinition<C>
    where
        Run: Fn(I, Call<C>) -> Work + Send + Sync + 'static,
        Work: Future<Output = RunResult<O, F>> + Send + 'static,
    {
        let has_input = self.input.is_some();
        let has_output = self.output.is_some();
        let run: ErasedRun<C> = Arc::new(move |input: Value, call: Call<C>| {
            let input: I = serde_json::from_value(if has_input { input } else { Value::Null })
                .map_err(|error| error.to_string())?;
            let work = run(input, call);
            Ok(Box::pin(async move {
                match work.await {
                    Ok(value) if has_output => Ok(Ok(serde_json::to_value(value)?)),
                    Ok(_) => Ok(Ok(Value::Null)),
                    Err(RunError::Failure(failure)) => Ok(Err(serde_json::to_value(failure)?)),
                    Err(RunError::Defect(defect)) => Err(defect),
                }
            }) as BoxFuture<'static, _>)
        });
        CapabilityDefinition {
            id: self.id,
            description: self.description,
            audience: self.audience,
            read_only: self.read_only,
            input: self.input,
            output: self.output,
            failures: self.failures,
            types: self.types,
            problems: self.problems,
            availability: self.availability,
            state: self.state,
            run,
        }
    }
}

/// The schema of each failure, from the schema of an enum with `#[serde(tag = "_tag")]`.
fn failures_of(schema: &Value) -> Result<Vec<(String, Value)>, String> {
    let variants: Vec<&Value> = match schema
        .get("oneOf")
        .or_else(|| schema.get("anyOf"))
        .and_then(Value::as_array)
    {
        Some(variants) => variants.iter().collect(),
        None => vec![schema],
    };
    variants
        .into_iter()
        .map(|variant| {
            let tag = variant
                .pointer("/properties/_tag/const")
                .and_then(Value::as_str)
                .ok_or("each variant must be an object with a constant _tag. Use #[serde(tag = \"_tag\")]")?;
            let mut variant = variant.clone();
            if let Some(object) = variant.as_object_mut() {
                object.remove("title");
                object.remove("description");
            }
            Ok((tag.to_owned(), variant))
        })
        .collect()
}

/// A capability, ready to be served.
pub struct CapabilityDefinition<C> {
    pub(crate) id: String,
    pub(crate) description: String,
    pub(crate) audience: Vec<String>,
    pub(crate) read_only: bool,
    pub(crate) input: Option<Value>,
    pub(crate) output: Option<Value>,
    pub(crate) failures: Vec<(String, Value)>,
    types: Map<String, Value>,
    problems: Vec<String>,
    pub(crate) availability: Option<AvailabilityFn<C>>,
    pub(crate) state: Option<(Value, StateFn<C>)>,
    pub(crate) run: ErasedRun<C>,
}

/// An event that is being declared. `I` and `P` are the types of the input and of the payload. Finish it with
/// [`Event::subscribe`].
pub struct Event<C, I = (), P = NoPayload> {
    id: String,
    description: String,
    audience: Vec<String>,
    input: Option<Value>,
    payload: Option<Value>,
    types: Map<String, Value>,
    problems: Vec<String>,
    marker: PhantomData<fn(I, C) -> P>,
}

impl<C> Event<C> {
    /// Start an event with no input and no payload.
    pub fn new(id: impl Into<String>, description: impl Into<String>) -> Self {
        Event {
            id: id.into(),
            description: description.into(),
            audience: Vec::new(),
            input: None,
            payload: None,
            types: Map::new(),
            problems: Vec::new(),
            marker: PhantomData,
        }
    }
}

impl<C, I, P> Event<C, I, P> {
    fn retype<I2, P2>(self) -> Event<C, I2, P2> {
        Event {
            id: self.id,
            description: self.description,
            audience: self.audience,
            input: self.input,
            payload: self.payload,
            types: self.types,
            problems: self.problems,
            marker: PhantomData,
        }
    }

    fn add_types(&mut self, types: Map<String, Value>) {
        for (name, schema) in types {
            if let Some(existing) = self.types.get(&name)
                && *existing != schema
            {
                self.problems
                    .push(format!("the type {name} has two different schemas"));
            }
            self.types.insert(name, schema);
        }
    }

    /// The targets that can follow the event.
    pub fn audience<S: Into<String>>(mut self, targets: impl IntoIterator<Item = S>) -> Self {
        self.audience = targets.into_iter().map(Into::into).collect();
        self
    }

    /// The input type of a subscription. Its schema is the input schema of the event.
    pub fn input<T: JsonSchema + DeserializeOwned>(mut self) -> Event<C, T, P> {
        let (schema, types) = schema_of::<T>();
        self.input = Some(schema);
        self.add_types(types);
        self.retype()
    }

    /// The input type of a subscription, with a schema that you write.
    pub fn input_schema<T: DeserializeOwned>(mut self, schema: Value) -> Event<C, T, P> {
        self.input = Some(schema);
        self.retype()
    }

    /// The type of the data of each occurrence. Its schema is the payload schema of the event.
    pub fn payload<T: JsonSchema + Serialize>(mut self) -> Event<C, I, T> {
        let (schema, types) = schema_of::<T>();
        self.payload = Some(schema);
        self.add_types(types);
        self.retype()
    }

    /// The type of the data of each occurrence, with a schema that you write.
    pub fn payload_schema<T: Serialize>(mut self, schema: Value) -> Event<C, I, T> {
        self.payload = Some(schema);
        self.retype()
    }
}

impl<C, I, P> Event<C, I, P>
where
    C: Send + Sync + 'static,
    I: DeserializeOwned + Send + 'static,
    P: Serialize + Send + 'static,
{
    /// The provider of the event: a stream of occurrences for each subscription. An `Err` item, or a panic, ends the
    /// subscription with the call failure `internal`. The end of the stream ends the subscription as complete. When
    /// the subscription ends in another way, the core drops the stream.
    pub fn subscribe<Provider, Occurrences>(self, provider: Provider) -> EventDefinition<C>
    where
        Provider: Fn(I, Subscription<C>) -> Occurrences + Send + Sync + 'static,
        Occurrences: Stream<Item = Result<Emitted<P>, Defect>> + Send + 'static,
    {
        let has_input = self.input.is_some();
        let subscribe: ErasedSubscribe<C> =
            Arc::new(move |input: Value, subscription: Subscription<C>| {
                let input: I = serde_json::from_value(if has_input { input } else { Value::Null })
                    .map_err(|error| error.to_string())?;
                let stream = provider(input, subscription).map(|item| {
                    let emitted = item?;
                    Ok(Emitted {
                        data: serde_json::to_value(emitted.data)?,
                        event_id: emitted.event_id,
                        timestamp: emitted.timestamp,
                        cursor: emitted.cursor,
                        truncated: emitted.truncated,
                    })
                });
                Ok(stream.boxed())
            });
        EventDefinition {
            id: self.id,
            description: self.description,
            audience: self.audience,
            input: self.input,
            payload: self.payload,
            types: self.types,
            problems: self.problems,
            subscribe,
        }
    }
}

/// An event, ready to be served.
pub struct EventDefinition<C> {
    pub(crate) id: String,
    pub(crate) description: String,
    pub(crate) audience: Vec<String>,
    pub(crate) input: Option<Value>,
    pub(crate) payload: Option<Value>,
    types: Map<String, Value>,
    problems: Vec<String>,
    pub(crate) subscribe: ErasedSubscribe<C>,
}

/// A capability that the application serves, with the validators of its schemas.
pub(crate) struct ServedCapability<C> {
    pub(crate) definition: CapabilityDefinition<C>,
    pub(crate) input: Option<Validator>,
    pub(crate) output: Option<Validator>,
    pub(crate) failures: HashMap<String, Validator>,
}

/// An event that the application serves, with the validators of its schemas.
pub(crate) struct ServedEvent<C> {
    pub(crate) definition: EventDefinition<C>,
    pub(crate) input: Option<Validator>,
    pub(crate) payload: Option<Validator>,
}

type OnDefect = Arc<dyn Fn(&str, &Defect) + Send + Sync>;

/// An application that is being declared. Finish it with [`App::build`].
pub struct App<C> {
    title: Option<String>,
    description: Option<String>,
    targets: Vec<(String, Target)>,
    types: Map<String, Value>,
    capabilities: Vec<CapabilityDefinition<C>>,
    events: Vec<EventDefinition<C>>,
    on_defect: Option<OnDefect>,
}

impl<C: Send + Sync + 'static> Default for App<C> {
    fn default() -> Self {
        Self::new()
    }
}

impl<C: Send + Sync + 'static> App<C> {
    pub fn new() -> Self {
        App {
            title: None,
            description: None,
            targets: Vec::new(),
            types: Map::new(),
            capabilities: Vec::new(),
            events: Vec::new(),
            on_defect: None,
        }
    }

    pub fn title(mut self, title: impl Into<String>) -> Self {
        self.title = Some(title.into());
        self
    }

    /// What the application does. It is also the MCP instructions of the server, if the server gives none.
    pub fn description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// A target, and the bindings that serve it.
    pub fn target<S: Into<String>>(
        mut self,
        name: impl Into<String>,
        bindings: impl IntoIterator<Item = S>,
    ) -> Self {
        let bindings = bindings.into_iter().map(Into::into).collect();
        self.targets.push((
            name.into(),
            Target {
                bindings,
                ..Target::default()
            },
        ));
        self
    }

    /// A target with all its members: its bindings, a description of its clients, and the options of its bindings.
    pub fn target_with(mut self, name: impl Into<String>, target: Target) -> Self {
        self.targets.push((name.into(), target));
        self
    }

    /// A shared type for the schemas that you write: refer to it with `{ "$ref": "#/$defs/<name>" }`.
    pub fn r#type(mut self, name: impl Into<String>, schema: Value) -> Self {
        self.types.insert(name.into(), schema);
        self
    }

    pub fn capability(mut self, capability: CapabilityDefinition<C>) -> Self {
        self.capabilities.push(capability);
        self
    }

    pub fn event(mut self, event: EventDefinition<C>) -> Self {
        self.events.push(event);
        self
    }

    /// Record a defect: the id of the capability or the event, and the cause. The default writes it to standard error.
    pub fn on_defect(mut self, on_defect: impl Fn(&str, &Defect) + Send + Sync + 'static) -> Self {
        self.on_defect = Some(Arc::new(on_defect));
        self
    }

    /// Check the application and write its catalog. The result is the application, ready to serve, or the rules
    /// that it breaks.
    pub fn build(mut self) -> Result<Arc<Application<C>>, Vec<String>> {
        let mut problems = Vec::new();
        let mut types = self.types;
        let mut merge = |more: &Map<String, Value>, problems: &mut Vec<String>| {
            for (name, schema) in more {
                match types.get(name) {
                    Some(existing) if existing != schema => {
                        problems.push(format!("the type {name} has two different schemas"))
                    }
                    _ => {
                        types.insert(name.clone(), schema.clone());
                    }
                }
            }
        };
        for capability in &self.capabilities {
            problems.extend(capability.problems.iter().cloned());
            merge(&capability.types, &mut problems);
        }
        for event in &self.events {
            problems.extend(event.problems.iter().cloned());
            merge(&event.types, &mut problems);
        }
        share_types(&mut self.capabilities, &mut self.events, &mut types);

        let mut document =
            catalog::Catalog::new(self.title.as_deref(), self.description.as_deref());
        for (name, target) in &self.targets {
            document.target(name, target.clone());
        }
        for (name, schema) in &types {
            document.r#type(name, schema.clone());
        }
        for capability in &self.capabilities {
            document.capability(
                &capability.id,
                catalog::Capability {
                    description: capability.description.clone(),
                    audience: capability.audience.clone(),
                    input: capability.input.clone(),
                    output: capability.output.clone(),
                    failures: capability.failures.clone(),
                    read_only: capability.read_only,
                    state: capability.state.as_ref().map(|(schema, _)| schema.clone()),
                },
            );
        }
        for event in &self.events {
            document.event(
                &event.id,
                catalog::Event {
                    description: event.description.clone(),
                    audience: event.audience.clone(),
                    input: event.input.clone(),
                    payload: event.payload.clone(),
                },
            );
        }
        let json = match document.to_json() {
            Ok(json) => json,
            Err(rules) => {
                problems.extend(rules);
                Value::Null
            }
        };

        let validator =
            |what: &str, schema: &Option<Value>, problems: &mut Vec<String>| -> Option<Validator> {
                let schema = schema.as_ref()?;
                match Validator::new(schema, &types) {
                    Ok(validator) => Some(validator),
                    Err(error) => {
                        problems.push(format!("{what} is not a valid JSON Schema: {error}"));
                        None
                    }
                }
            };
        let mut capabilities = Vec::new();
        for definition in self.capabilities {
            let input = validator(
                &format!("the input schema of {}", definition.id),
                &definition.input,
                &mut problems,
            );
            let output = validator(
                &format!("the output schema of {}", definition.id),
                &definition.output,
                &mut problems,
            );
            let mut failures = HashMap::new();
            for (tag, schema) in &definition.failures {
                if let Some(checked) = validator(
                    &format!("the failure {tag} of {}", definition.id),
                    &Some(schema.clone()),
                    &mut problems,
                ) {
                    failures.insert(tag.clone(), checked);
                }
            }
            capabilities.push(Arc::new(ServedCapability {
                definition,
                input,
                output,
                failures,
            }));
        }
        let mut events = Vec::new();
        for definition in self.events {
            let input = validator(
                &format!("the input schema of {}", definition.id),
                &definition.input,
                &mut problems,
            );
            let payload = validator(
                &format!("the payload schema of {}", definition.id),
                &definition.payload,
                &mut problems,
            );
            events.push(Arc::new(ServedEvent {
                definition,
                input,
                payload,
            }));
        }
        if !problems.is_empty() {
            return Err(problems);
        }
        let views = self
            .targets
            .iter()
            .map(|(name, _)| (name.clone(), Arc::new(view_of(&json, name))))
            .collect();
        let on_defect = self.on_defect.unwrap_or_else(|| {
            Arc::new(|id: &str, defect: &Defect| {
                eprintln!("A capability or an event failed with a defect: {id}: {defect}")
            })
        });
        Ok(Arc::new(Application {
            catalog: json,
            views,
            capabilities,
            events,
            on_defect,
        }))
    }
}

/// An application, checked and ready to serve. Sessions and bindings serve it.
pub struct Application<C> {
    catalog: Value,
    views: HashMap<String, Arc<Value>>,
    pub(crate) capabilities: Vec<Arc<ServedCapability<C>>>,
    pub(crate) events: Vec<Arc<ServedEvent<C>>>,
    pub(crate) on_defect: OnDefect,
}

impl<C> Application<C> {
    /// The catalog of the application, as JSON.
    pub fn catalog(&self) -> &Value {
        &self.catalog
    }

    /// The catalog of the application as JSON text in canonical form (spec/catalog.md#canonical-form).
    pub fn render_catalog(&self) -> String {
        catalog::canonical_text(&self.catalog)
    }

    /// The view of a target (spec/catalog.md#views).
    pub fn view(&self, target: &str) -> Arc<Value> {
        self.views
            .get(target)
            .cloned()
            .unwrap_or_else(|| Arc::new(view_of(&self.catalog, target)))
    }

    /// The description of the application, which is the default MCP instructions.
    pub fn description(&self) -> Option<&str> {
        self.catalog.get("description").and_then(Value::as_str)
    }

    pub(crate) fn defect(&self, id: &str, defect: &Defect) {
        (self.on_defect)(id, defect);
    }
}

pub(crate) fn call<C>(context: Arc<C>, cancel: CancellationToken) -> Call<C> {
    Call { context, cancel }
}

pub(crate) fn subscription<C>(
    context: Arc<C>,
    cursor: Option<String>,
    max_age_ms: Option<u64>,
    cancel: CancellationToken,
) -> Subscription<C> {
    Subscription {
        context,
        cursor,
        max_age_ms,
        cancel,
    }
}

/// Move each named schema that the application uses in two or more places into the shared types, and refer to it
/// there (spec/catalog.md#types). The name of a schema is its `title`, or the tag of a failure.
fn share_types<C>(
    capabilities: &mut [CapabilityDefinition<C>],
    events: &mut [EventDefinition<C>],
    types: &mut Map<String, Value>,
) {
    fn named(schema: &Value) -> Option<(String, Value)> {
        let title = schema.get("title")?.as_str()?;
        Some((title.to_owned(), schema.clone()))
    }
    let mut candidates: Vec<(String, Value, usize)> = Vec::new();
    let mut note = |candidate: Option<(String, Value)>| {
        let Some((name, schema)) = candidate else {
            return;
        };
        match candidates
            .iter_mut()
            .find(|(each, value, _)| *each == name && *value == schema)
        {
            Some((_, _, count)) => *count += 1,
            None => candidates.push((name, schema, 1)),
        }
    };
    for capability in capabilities.iter() {
        [&capability.input, &capability.output]
            .into_iter()
            .flatten()
            .for_each(|schema| note(named(schema)));
        if let Some((schema, _)) = &capability.state {
            note(named(schema));
        }
        for (tag, schema) in &capability.failures {
            note(Some((tag.clone(), schema.clone())));
        }
    }
    for event in events.iter() {
        [&event.input, &event.payload]
            .into_iter()
            .flatten()
            .for_each(|schema| note(named(schema)));
    }
    let is_type_name = |name: &str| {
        name.chars()
            .next()
            .is_some_and(|first| first.is_ascii_alphabetic())
            && name
                .chars()
                .all(|each| each.is_ascii_alphanumeric() || each == '_')
    };
    let shared: Vec<(String, Value)> = candidates
        .into_iter()
        .filter(|(name, schema, count)| {
            let mut stored = schema.clone();
            if let Some(object) = stored.as_object_mut() {
                object.remove("title");
            }
            *count >= 2
                && is_type_name(name)
                && types.get(name).is_none_or(|existing| *existing == stored)
        })
        .map(|(name, schema, _)| (name, schema))
        .collect();
    let reference = |schema: &mut Value| {
        if let Some((name, _)) = shared.iter().find(|(_, value)| value == schema) {
            *schema = serde_json::json!({ "$ref": format!("#/$defs/{name}") });
        }
    };
    for (name, schema) in &shared {
        let mut stored = schema.clone();
        if let Some(object) = stored.as_object_mut() {
            object.remove("title");
        }
        types.insert(name.clone(), stored);
    }
    for capability in capabilities.iter_mut() {
        [&mut capability.input, &mut capability.output]
            .into_iter()
            .flatten()
            .for_each(reference);
        if let Some((schema, _)) = &mut capability.state {
            reference(schema);
        }
        capability
            .failures
            .iter_mut()
            .for_each(|(_, schema)| reference(schema));
    }
    for event in events.iter_mut() {
        [&mut event.input, &mut event.payload]
            .into_iter()
            .flatten()
            .for_each(reference);
    }
}
