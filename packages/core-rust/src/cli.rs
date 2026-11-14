//! The CLI binding (spec/bindings/cli.md): a command line made from the view of a target.

use std::io::Write;
use std::sync::Arc;

use futures::future::BoxFuture;
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use crate::app::Application;
use crate::outcome::{Availability, CallFailure, Kind, Outcome};
use crate::schema::{bundle, resolve};
use crate::session::{Session, SubscribeOptions};

/// The exit codes of the outcomes (spec/bindings/cli.md#outcomes).
pub mod exit {
    pub const VALUE: i32 = 0;
    pub const FAILURE: i32 = 1;
    pub const UNKNOWN_CAPABILITY: i32 = 2;
    pub const INVALID_INPUT: i32 = 3;
    pub const UNAVAILABLE: i32 = 4;
    pub const INTERNAL: i32 = 5;
    pub const CANCELLED: i32 = 130;
}

/// The commands of the command line itself. No other command can have their names.
const GENERIC_COMMANDS: [&str; 3] = ["call", "list", "watch"];

/// The flags of `watch` that give the cursor and `maxAgeMs`. No input property of an event can have these names.
const RESUME_FLAGS: [&str; 2] = ["cursor", "max-age-ms"];

/// Where the command line writes, and the token that an interrupt cancels.
pub struct CliIo {
    pub stdout: Box<dyn FnMut(&str) + Send>,
    pub stderr: Box<dyn FnMut(&str) + Send>,
    /// Cancelled by an interrupt. It cancels the call or the subscription.
    pub cancel: CancellationToken,
}

impl CliIo {
    /// Standard output and standard error of the process. Each text is one line, written at once.
    pub fn standard(cancel: CancellationToken) -> Self {
        CliIo {
            stdout: Box::new(|text| {
                let mut stdout = std::io::stdout().lock();
                let _ = writeln!(stdout, "{text}");
                let _ = stdout.flush();
            }),
            stderr: Box::new(|text| {
                let mut stderr = std::io::stderr().lock();
                let _ = writeln!(stderr, "{text}");
                let _ = stderr.flush();
            }),
            cancel,
        }
    }
}

/// The work of a command of the application: the arguments after its name, the io and the services. The result is
/// the exit code.
pub type CommandRun<C> =
    Arc<dyn for<'a> Fn(Vec<String>, &'a mut CliIo, Arc<C>) -> BoxFuture<'a, i32> + Send + Sync>;

/// A command that the application adds to the command line.
pub struct CliCommand<C> {
    pub name: String,
    /// The text that the help gives for the command.
    pub description: String,
    pub run: CommandRun<C>,
}

/// The settings of the command line.
pub struct CliOptions<C> {
    /// The name of the program.
    pub name: String,
    pub version: String,
    /// The target that the command line serves. The default is `cli`.
    pub target: String,
    /// The text at the top of the help. The default is the description of the application, then `name`.
    pub description: Option<String>,
    /// The commands of the application. The name of each one must not be `call`, `list`, `watch`, the name of
    /// another command of the application, or the first word of the command of a capability.
    pub commands: Vec<CliCommand<C>>,
}

impl<C> CliOptions<C> {
    pub fn new(name: impl Into<String>, version: impl Into<String>) -> Self {
        CliOptions {
            name: name.into(),
            version: version.into(),
            target: "cli".into(),
            description: None,
            commands: Vec::new(),
        }
    }
}

/// Run the command line as the main program, with the arguments of the process, and exit with its exit code. An
/// interrupt (`SIGINT`) cancels the call or the subscription.
pub async fn cli_main<C: Send + Sync + 'static>(
    app: Arc<Application<C>>,
    context: Arc<C>,
    options: CliOptions<C>,
) -> ! {
    let args = std::env::args().skip(1).collect();
    let code = run_cli_process(app, context, options, args).await;
    std::process::exit(code)
}

/// Run the command line with arguments, on standard output and standard error. An interrupt (`SIGINT`) cancels the
/// call or the subscription. The result is the exit code.
pub async fn run_cli_process<C: Send + Sync + 'static>(
    app: Arc<Application<C>>,
    context: Arc<C>,
    options: CliOptions<C>,
    args: Vec<String>,
) -> i32 {
    let cancel = CancellationToken::new();
    listen_for_interrupt(cancel.clone());
    let mut io = CliIo::standard(cancel);
    match run_cli(&app, context, &options, &args, &mut io).await {
        Ok(code) => code,
        Err(problem) => {
            (io.stderr)(&problem);
            exit::INTERNAL
        }
    }
}

/// Cancel `cancel` on an interrupt. The handler is in place when this function returns, before the command runs: an
/// interrupt that comes at once cancels the command, and does not end the process by the signal.
fn listen_for_interrupt(cancel: CancellationToken) {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        if let Ok(mut interrupts) = signal(SignalKind::interrupt()) {
            tokio::spawn(async move {
                if interrupts.recv().await.is_some() {
                    cancel.cancel();
                }
            });
            return;
        }
    }
    // `ctrl_c` puts its handler in place when it is first polled. Poll it once here, so that it is in place now.
    let mut interrupt = Box::pin(tokio::signal::ctrl_c());
    let waker = futures::task::noop_waker();
    let _ = interrupt
        .as_mut()
        .poll(&mut std::task::Context::from_waker(&waker));
    tokio::spawn(async move {
        if interrupt.await.is_ok() {
            cancel.cancel();
        }
    });
}

struct UsageError {
    message: String,
    code: i32,
}

fn usage_error(message: impl Into<String>, code: i32) -> UsageError {
    UsageError {
        message: message.into(),
        code,
    }
}

/// Run the command line with arguments. The result is the exit code (spec/bindings/cli.md#outcomes), or a rule of
/// the commands that the application breaks.
pub async fn run_cli<C: Send + Sync + 'static>(
    app: &Arc<Application<C>>,
    context: Arc<C>,
    options: &CliOptions<C>,
    args: &[String],
    io: &mut CliIo,
) -> Result<i32, String> {
    let session = Session::open(app, &options.target, context.clone());
    let close = session.clone();
    let _close = crate::remote::OnDrop(move || close.close());
    let view = session.view().clone();
    let types = view
        .get("$defs")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let commands: Vec<(String, Vec<String>)> = session
        .capability_ids()
        .iter()
        .map(|id| (id.clone(), id.split('.').map(str::to_owned).collect()))
        .collect();
    for (_, path) in &commands {
        if GENERIC_COMMANDS.contains(&path[0].as_str()) {
            return Err(format!(
                "The command {} has the same name as a command of the command line.",
                path.join(" ")
            ));
        }
        if let Some((_, longer)) = commands
            .iter()
            .find(|(_, other)| other.len() > path.len() && other.starts_with(path))
        {
            return Err(format!(
                "The command {} is also the start of the command {}. A shared prefix only contains other commands.",
                path.join(" "),
                longer.join(" ")
            ));
        }
    }
    for id in session.event_ids() {
        let input = view
            .pointer(&format!("/events/{id}/input"))
            .map(|input| bundle(input, &types));
        if let Some(flag) = RESUME_FLAGS.iter().find(|flag| {
            input
                .as_ref()
                .and_then(|input| input.get("properties"))
                .and_then(|properties| properties.get(**flag))
                .is_some()
        }) {
            return Err(format!(
                "The input of the event {id} has a property {flag}, which is a flag of watch."
            ));
        }
    }
    let mut taken: Vec<String> = GENERIC_COMMANDS
        .iter()
        .map(|name| (*name).to_owned())
        .chain(commands.iter().map(|(_, path)| path[0].clone()))
        .collect();
    for command in &options.commands {
        if taken.contains(&command.name) {
            return Err(format!(
                "The command {} of the application has the same name as another command.",
                command.name
            ));
        }
        taken.push(command.name.clone());
    }

    let capability = |id: &str| {
        view.get("capabilities")
            .and_then(|capabilities| capabilities.get(id))
            .cloned()
            .unwrap_or_else(|| json!({}))
    };
    let schema_of = |entry: &Value| entry.get("input").map(|input| bundle(input, &types));
    let result: Result<i32, UsageError> = async {
        let first = args.first().map(String::as_str);
        match first {
            None | Some("--help" | "-h") => {
                let description = options
                    .description
                    .clone()
                    .or_else(|| app.description().map(str::to_owned))
                    .unwrap_or_else(|| options.name.clone());
                let mut lines = vec![
                    description,
                    String::new(),
                    format!("Usage: {} <command> [flags]", options.name),
                    String::new(),
                    "Commands:".into(),
                ];
                lines.extend(
                    commands
                        .iter()
                        .map(|(_, path)| format!("  {}", path.join(" "))),
                );
                lines.push("  call <id> [input]".into());
                lines.push("  list".into());
                if !session.event_ids().is_empty() {
                    lines.push(
                        "  watch <id> [flags] [--cursor <string>] [--max-age-ms <integer>]".into(),
                    );
                }
                lines.extend(
                    options
                        .commands
                        .iter()
                        .map(|command| format!("  {}  {}", command.name, command.description)),
                );
                (io.stdout)(&lines.join("\n"));
                Ok(exit::VALUE)
            }
            Some("--version" | "-v") => {
                (io.stdout)(&options.version);
                Ok(exit::VALUE)
            }
            Some("list") => {
                let mut entries = Vec::new();
                for id in session.capability_ids() {
                    let entry = capability(id);
                    let mut item = Map::new();
                    item.insert("kind".into(), json!("capability"));
                    item.insert("id".into(), json!(id));
                    item.insert(
                        "description".into(),
                        entry.get("description").cloned().unwrap_or(Value::Null),
                    );
                    item.extend(
                        session
                            .availability(id)
                            .map(|availability| availability.members())
                            .unwrap_or_default(),
                    );
                    item.insert(
                        "usage".into(),
                        json!(usage(&options.name, id, schema_of(&entry).as_ref())),
                    );
                    entries.push(Value::Object(item));
                }
                for id in session.event_ids() {
                    let event = view
                        .get("events")
                        .and_then(|events| events.get(id.as_str()))
                        .cloned()
                        .unwrap_or_default();
                    entries.push(json!({
                        "kind": "event",
                        "id": id,
                        "description": event.get("description").cloned().unwrap_or(Value::Null),
                        "usage": event_usage(&options.name, id, schema_of(&event).as_ref()),
                    }));
                }
                (io.stdout)(&serde_json::to_string_pretty(&entries).unwrap_or_default());
                Ok(exit::VALUE)
            }
            Some("call") => {
                let id = args.get(1).ok_or_else(|| {
                    usage_error("Give the id of a capability.", exit::INVALID_INPUT)
                })?;
                let text = args.get(2).map_or("{}", String::as_str);
                let Ok(input) = serde_json::from_str::<Value>(text) else {
                    // Text that is not JSON is invalid input, but the kinds before it in spec/invocation.md#call-failures
                    // come first: cancelled, unknown-capability and unavailable.
                    let failure = match session.availability(id) {
                        _ if io.cancel.is_cancelled() => CallFailure::cancelled(),
                        None => CallFailure::new(
                            Kind::UnknownCapability,
                            format!("There is no capability {id}."),
                        ),
                        Some(Availability::Unavailable { reason }) => {
                            CallFailure::new(Kind::Unavailable, reason)
                        }
                        Some(Availability::Available) => {
                            CallFailure::new(Kind::InvalidInput, "The input is not JSON.")
                        }
                    };
                    return Ok(print(io, &Outcome::CallFailure(failure)));
                };
                let outcome = session.invoke(id, input, &io.cancel).await;
                Ok(print(io, &outcome))
            }
            Some("watch") => watch(&session, &view, &types, &options.name, &args[1..], io).await,
            Some(name) if options.commands.iter().any(|command| command.name == name) => {
                let command = options
                    .commands
                    .iter()
                    .find(|command| command.name == name)
                    .map(|command| command.run.clone());
                match command {
                    Some(run) => Ok(run(args[1..].to_vec(), io, context.clone()).await),
                    None => Ok(exit::UNKNOWN_CAPABILITY),
                }
            }
            Some(_) => {
                let found = commands
                    .iter()
                    .filter(|(_, path)| {
                        path.len() <= args.len()
                            && path.iter().zip(args).all(|(word, arg)| word == arg)
                    })
                    .max_by_key(|(_, path)| path.len());
                let Some((id, path)) = found else {
                    let words: Vec<&str> = args
                        .iter()
                        .map(String::as_str)
                        .filter(|arg| !arg.starts_with('-'))
                        .collect();
                    return Err(usage_error(
                        format!("There is no command {}.", words.join(" ")),
                        exit::UNKNOWN_CAPABILITY,
                    ));
                };
                let entry = capability(id);
                let schema = schema_of(&entry).unwrap_or_else(|| json!({ "type": "object" }));
                let flags = &args[path.len()..];
                if flags.iter().any(|flag| flag == "--help" || flag == "-h") {
                    let description = entry
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let words: Vec<String> = std::iter::once(options.name.clone())
                        .chain(path.iter().cloned())
                        .chain(cli_flags(&schema))
                        .collect();
                    (io.stdout)(&format!("Usage: {}\n\n{description}", words.join(" ")));
                    return Ok(exit::VALUE);
                }
                let input = parse_flags(flags, &schema)?;
                let outcome = session.invoke(id, Value::Object(input), &io.cancel).await;
                Ok(print(io, &outcome))
            }
        }
    }
    .await;
    Ok(result.unwrap_or_else(|error| {
        (io.stderr)(&error.message);
        error.code
    }))
}

/// Subscribe to an event, and write each occurrence on one line (spec/bindings/cli.md#events).
async fn watch<C: Send + Sync + 'static>(
    session: &Session<C>,
    view: &Value,
    types: &Map<String, Value>,
    program: &str,
    args: &[String],
    io: &mut CliIo,
) -> Result<i32, UsageError> {
    let (flags, cursor, max_age_ms) = resume_flags(args)?;
    let Some((id, flags)) = flags.split_first() else {
        return Err(usage_error("Give the id of an event.", exit::INVALID_INPUT));
    };
    let mut input = json!({});
    if let Some(event) = view
        .get("events")
        .and_then(|events| events.get(id.as_str()))
    {
        let schema = bundle(
            event.get("input").unwrap_or(&json!({ "type": "object" })),
            types,
        );
        if flags.iter().any(|flag| flag == "--help" || flag == "-h") {
            let description = event
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or_default();
            (io.stdout)(&format!(
                "Usage: {}\n\n{description}",
                event_usage(program, id, event.get("input").map(|_| &schema))
            ));
            return Ok(exit::VALUE);
        }
        if schema.get("properties").is_some() {
            input = Value::Object(parse_flags(flags, &schema)?);
        } else {
            if let Some(extra) = flags.get(1) {
                return Err(usage_error(
                    format!("Unexpected argument {extra}."),
                    exit::INVALID_INPUT,
                ));
            }
            match serde_json::from_str(flags.first().map_or("{}", String::as_str)) {
                Ok(parsed) => input = parsed,
                Err(_) => {
                    return Ok(print(
                        io,
                        &Outcome::CallFailure(CallFailure::new(
                            Kind::InvalidInput,
                            "The input is not JSON.",
                        )),
                    ));
                }
            }
        }
    }
    let options = SubscribeOptions {
        cursor,
        max_age_ms,
        cancel: io.cancel.clone(),
    };
    let mut occurrences = match session.subscribe(id, input, options) {
        Ok(occurrences) => occurrences,
        Err(failure) => return Ok(print(io, &Outcome::CallFailure(failure))),
    };
    loop {
        let next = tokio::select! {
            biased;
            () = io.cancel.cancelled() => return Ok(exit::CANCELLED),
            next = occurrences.next() => next,
        };
        match next {
            None => {
                return Ok(if io.cancel.is_cancelled() {
                    exit::CANCELLED
                } else {
                    exit::VALUE
                });
            }
            Some(Err(failure)) => {
                (io.stderr)(&failure.to_json().to_string());
                return Ok(exit::INTERNAL);
            }
            Some(Ok(occurrence)) => (io.stdout)(&occurrence.to_json().to_string()),
        }
    }
}

/// Write an outcome, and give its exit code.
fn print(io: &mut CliIo, outcome: &Outcome) -> i32 {
    match outcome {
        Outcome::Value(value) => {
            (io.stdout)(&serde_json::to_string_pretty(value).unwrap_or_default());
            exit::VALUE
        }
        Outcome::Failure(error) => {
            (io.stdout)(&serde_json::to_string_pretty(error).unwrap_or_default());
            exit::FAILURE
        }
        Outcome::CallFailure(failure) => {
            (io.stderr)(&failure.to_json().to_string());
            match failure.kind {
                Kind::UnknownCapability => exit::UNKNOWN_CAPABILITY,
                Kind::InvalidInput => exit::INVALID_INPUT,
                Kind::Unavailable => exit::UNAVAILABLE,
                Kind::Internal => exit::INTERNAL,
                Kind::Cancelled => exit::CANCELLED,
            }
        }
    }
}

/// Split a flag into its name and its value after `=`, if it has one.
fn split_flag(arg: &str) -> Option<(&str, Option<&str>)> {
    let flag = arg.strip_prefix("--")?;
    Some(match flag.split_once('=') {
        Some((name, value)) => (name, Some(value)),
        None => (flag, None),
    })
}

/// The arguments of `watch` without the resume flags, the cursor, and `maxAgeMs`.
type Resume = (Vec<String>, Option<String>, Option<f64>);

/// Take `--cursor` and `--max-age-ms` out of the arguments of `watch`.
fn resume_flags(args: &[String]) -> Result<Resume, UsageError> {
    let mut rest = Vec::new();
    let mut cursor = None;
    let mut max_age_ms = None;
    let mut remaining = args.iter();
    while let Some(arg) = remaining.next() {
        let Some((name, inline)) = split_flag(arg).filter(|(name, _)| RESUME_FLAGS.contains(name))
        else {
            rest.push(arg.clone());
            continue;
        };
        let text = inline
            .map(str::to_owned)
            .or_else(|| remaining.next().cloned())
            .ok_or_else(|| {
                usage_error(
                    format!("The flag --{name} needs a value."),
                    exit::INVALID_INPUT,
                )
            })?;
        if name == "cursor" {
            cursor = Some(text);
        } else {
            let valid = !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit());
            let value = text
                .parse::<f64>()
                .ok()
                .filter(|value| valid && *value <= 9_007_199_254_740_991.0);
            max_age_ms = Some(value.ok_or_else(|| {
                usage_error(
                    "The flag --max-age-ms must be a whole number of milliseconds.",
                    exit::INVALID_INPUT,
                )
            })?);
        }
    }
    Ok((rest, cursor, max_age_ms))
}

/// The JSON object at a member, or an empty object.
fn object_at<'a>(value: &'a Value, member: &str) -> &'a Map<String, Value> {
    static EMPTY: std::sync::LazyLock<Map<String, Value>> = std::sync::LazyLock::new(Map::new);
    value
        .get(member)
        .and_then(Value::as_object)
        .unwrap_or(&EMPTY)
}

fn is_string_enum(schema: &Value) -> Option<Vec<&str>> {
    let values = schema.get("enum")?.as_array()?;
    let strings: Vec<&str> = values.iter().filter_map(Value::as_str).collect();
    (!values.is_empty() && strings.len() == values.len()).then_some(strings)
}

/// The schema of the items of a repeated flag, or `None` when the property does not give a repeated flag.
fn repeated_items(property: &Value, definitions: &Map<String, Value>) -> Option<Value> {
    if property.get("type") != Some(&json!("array")) {
        return None;
    }
    let items = resolve(
        property.get("items").filter(|items| items.is_object())?,
        definitions,
    )
    .clone();
    let simple = is_string_enum(&items).is_some()
        || matches!(
            items.get("type").and_then(Value::as_str),
            Some("integer" | "number" | "string")
        );
    simple.then_some(items)
}

fn flag_value(property: &Value) -> String {
    if let Some(strings) = is_string_enum(property) {
        return strings.join("|");
    }
    match property.get("type").and_then(Value::as_str) {
        Some(kind @ ("integer" | "number" | "string")) => kind.to_owned(),
        _ => "json".to_owned(),
    }
}

/// The flags of a command, as `usage` writes them: required flags first, each group in code point order of the names.
fn cli_flags(input: &Value) -> Vec<String> {
    let properties = object_at(input, "properties");
    let definitions = object_at(input, "$defs");
    let required: Vec<&str> = input
        .get("required")
        .and_then(Value::as_array)
        .map(|names| names.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let mut names: Vec<&String> = properties.keys().collect();
    names.sort();
    let (first, second): (Vec<&String>, Vec<&String>) = names
        .into_iter()
        .partition(|name| required.contains(&name.as_str()));
    first
        .into_iter()
        .chain(second)
        .map(|name| {
            let property = resolve(&properties[name], definitions);
            let flag = if let Some(items) = repeated_items(property, definitions) {
                format!("--{name} <{}>...", flag_value(&items))
            } else if property.get("type") == Some(&json!("boolean")) {
                format!("--{name}")
            } else {
                format!("--{name} <{}>", flag_value(property))
            };
            if required.contains(&name.as_str()) {
                flag
            } else {
                format!("[{flag}]")
            }
        })
        .collect()
}

/// The `usage` of a capability in `list`.
fn usage(program: &str, id: &str, input: Option<&Value>) -> String {
    if let Some(input) = input
        && input.get("properties").is_none()
    {
        return format!("{program} call {id} '<json>'");
    }
    let words: Vec<String> = std::iter::once(program.to_owned())
        .chain(id.split('.').map(str::to_owned))
        .chain(input.map(cli_flags).unwrap_or_default())
        .collect();
    words.join(" ")
}

/// The `usage` of an event in `list`.
fn event_usage(program: &str, id: &str, input: Option<&Value>) -> String {
    let resume = "[--cursor <string>] [--max-age-ms <integer>]";
    if let Some(input) = input
        && input.get("properties").is_none()
    {
        return format!("{program} watch {id} '<json>' {resume}");
    }
    let words: Vec<String> = [program.to_owned(), "watch".to_owned(), id.to_owned()]
        .into_iter()
        .chain(input.map(cli_flags).unwrap_or_default())
        .chain([resume.to_owned()])
        .collect();
    words.join(" ")
}

/// Make the input from the flags (spec/bindings/cli.md#commands).
fn parse_flags(args: &[String], schema: &Value) -> Result<Map<String, Value>, UsageError> {
    let properties = object_at(schema, "properties");
    let definitions = object_at(schema, "$defs");
    let mut input = Map::new();
    // The values of each repeated flag, in the order of the flags.
    let mut repeated: Vec<(String, Value, Vec<String>)> = Vec::new();
    let mut remaining = args.iter();
    while let Some(arg) = remaining.next() {
        let Some((name, inline)) = split_flag(arg) else {
            return Err(usage_error(
                format!("Unexpected argument {arg}."),
                exit::INVALID_INPUT,
            ));
        };
        let Some(property) = properties.get(name) else {
            return Err(usage_error(
                format!("Unknown flag --{name}."),
                exit::INVALID_INPUT,
            ));
        };
        let property = resolve(property, definitions);
        if property.get("type") == Some(&json!("boolean")) {
            input.insert(
                name.to_owned(),
                json!(inline.is_none_or(|value| value == "true")),
            );
            continue;
        }
        let text = inline
            .map(str::to_owned)
            .or_else(|| remaining.next().cloned())
            .ok_or_else(|| {
                usage_error(
                    format!("The flag --{name} needs a value."),
                    exit::INVALID_INPUT,
                )
            })?;
        match repeated_items(property, definitions) {
            None => {
                input.insert(name.to_owned(), value_of(name, &text, property)?);
            }
            Some(items) => match repeated.iter_mut().find(|(each, _, _)| each == name) {
                Some((_, _, values)) => values.push(text),
                None => repeated.push((name.to_owned(), items, vec![text])),
            },
        }
    }
    // A repeated flag gives JSON text of the whole array, or one item for each occurrence.
    for (name, items, values) in repeated {
        let json_array = match values.as_slice() {
            [only] => serde_json::from_str::<Value>(only)
                .ok()
                .filter(Value::is_array),
            _ => None,
        };
        let value = match json_array {
            Some(array) => array,
            None => Value::Array(
                values
                    .iter()
                    .map(|text| value_of(&name, text, &items))
                    .collect::<Result<_, _>>()?,
            ),
        };
        input.insert(name, value);
    }
    for name in schema
        .get("required")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        if !input.contains_key(name) {
            return Err(usage_error(
                format!("The flag --{name} is required."),
                exit::INVALID_INPUT,
            ));
        }
    }
    Ok(input)
}

/// The value of one flag, from the schema of its property.
fn value_of(name: &str, text: &str, property: &Value) -> Result<Value, UsageError> {
    if let Some(strings) = is_string_enum(property) {
        if !strings.contains(&text) {
            return Err(usage_error(
                format!("The flag --{name} must be one of: {}.", strings.join(", ")),
                exit::INVALID_INPUT,
            ));
        }
        return Ok(json!(text));
    }
    match property.get("type").and_then(Value::as_str) {
        Some(kind @ ("integer" | "number")) => {
            let number =
                text.trim().parse::<f64>().ok().filter(|number| {
                    number.is_finite() && (kind == "number" || number.fract() == 0.0)
                });
            let number = number.ok_or_else(|| {
                usage_error(
                    format!("The flag --{name} must be a {kind}."),
                    exit::INVALID_INPUT,
                )
            })?;
            // A whole number is an integer in JSON, as `Number` gives it in JavaScript.
            Ok(
                if number.fract() == 0.0 && number.abs() < 9_007_199_254_740_992.0 {
                    json!(number as i64)
                } else {
                    json!(number)
                },
            )
        }
        Some("string") => Ok(json!(text)),
        _ => serde_json::from_str(text).map_err(|_| {
            usage_error(
                format!("The flag --{name} must be JSON."),
                exit::INVALID_INPUT,
            )
        }),
    }
}
