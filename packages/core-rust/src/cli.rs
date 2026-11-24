//! The CLI surface (spec/surfaces/cli.md): a command line made from the catalog of a target.

use std::io::{IsTerminal, Write};
use std::sync::Arc;

use futures::FutureExt;
use futures::future::BoxFuture;
use futures::stream::{BoxStream, StreamExt};
use serde::Serialize;
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use crate::app::{Application, CapabilityDefinition, EventDefinition};
use crate::http::HttpClient;
use crate::outcome::{Availability, CallFailure, Kind, Outcome};
use crate::schema::{cli_input_schema, resolve};
use crate::session::{Session, SubscribeOptions};
use crate::subscription::Occurrence;

#[cfg(test)]
mod alias_cases;
mod human;
mod output;
mod output_generated;

use output::filled;
use output_generated::{
    GENERIC_COMMAND_MESSAGE, PROGRAM_FLAGS, RESERVED_FLAGS, RESUME_FLAGS, RESUME_PROPERTY_MESSAGE,
    SHARED_PREFIX_MESSAGE,
};

pub use human::{CliFormats, CliUi, OutputForm, output_form};
use human::{Formatted, aligned, output_color};
pub use output::{CliOutput, OutputDefault};

pub use crate::facts_generated::exit;
use crate::facts_generated::{
    ALIASES_NOT_OBJECT_MESSAGE, BAD_DEFAULT_MESSAGE, BAD_NAME_MESSAGE, BAD_TARGET_MESSAGE,
    COMMAND_PATH_MESSAGE, DEFAULT_HAS_RESERVED_FLAG_MESSAGE, FLAG_OF_DEFAULT_MESSAGE,
    GENERIC_COMMANDS, INPUT_NOT_OBJECT_MESSAGE, INTERRUPT_GRACE_MS, NO_CLI_SURFACE_MESSAGE,
    NO_PROPERTIES_MESSAGE, NOT_A_PROPERTY_MESSAGE, NOT_IN_TARGET_MESSAGE,
    RESERVED_FIRST_WORD_MESSAGE, RESERVED_NAME_MESSAGE, SETTINGS_NOT_OBJECT_MESSAGE,
    UNKNOWN_MEMBER_MESSAGE,
};

/// The time after the first interrupt at which [`cli_main`] and [`run_cli_process`] exit with code 130.
pub const INTERRUPT_GRACE: std::time::Duration =
    std::time::Duration::from_millis(INTERRUPT_GRACE_MS);

fn resume_words() -> impl Iterator<Item = &'static str> {
    RESUME_FLAGS
        .iter()
        .filter_map(|flag| flag.strip_prefix("--"))
}

/// A capability or an event that an alias names: a [`CapabilityDefinition`] or an [`EventDefinition`].
pub trait Aliased {
    /// The type of a fixed input: the type of the input of the capability, or of a subscription to the event, or
    /// [`NoInput`](crate::NoInput), which an alias cannot fix.
    type Input;

    /// The member of the alias that holds the id, `capability` or `event`, and the id.
    fn alias_of(&self) -> (&'static str, &str);
}

impl<C, X, O, F> Aliased for CapabilityDefinition<C, X, O, F> {
    type Input = X;

    fn alias_of(&self) -> (&'static str, &str) {
        ("capability", &self.id)
    }
}

impl<C, X, P> Aliased for EventDefinition<C, X, P> {
    type Input = X;

    fn alias_of(&self) -> (&'static str, &str) {
        ("event", &self.id)
    }
}

/// The aliases of the command line of a target (spec/surfaces/cli.md#aliases). Give them to
/// [`App::cli_aliases`](crate::App::cli_aliases), which writes them in `options.cli` of the target.
#[derive(Clone, Debug, Default)]
pub struct CliAliases {
    aliases: Map<String, Value>,
    defaults: Vec<String>,
    problems: Vec<String>,
}

impl CliAliases {
    pub fn new() -> Self {
        Self::default()
    }

    /// An alias of a capability or an event.
    pub fn alias(mut self, name: impl Into<String>, of: &impl Aliased) -> Self {
        let (member, id) = of.alias_of();
        self.aliases.insert(name.into(), json!({ member: id }));
        self
    }

    /// An alias of a capability or an event, with a fixed input. Each property of `fixed` that serializes to `null`,
    /// such as an `Option` that is `None`, is not fixed: it stays a flag of the alias.
    ///
    /// The fixed input has the type of the input of the definition:
    ///
    /// ```compile_fail
    /// # use acid_cat_core::{Capability, cli::CliAliases};
    /// # #[derive(serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
    /// # struct Power { on: bool }
    /// let power = Capability::<()>::new("power.set", "Turn the power on or off.")
    ///     .input::<Power>()
    ///     .run(|_: Power, _| async { Ok(()) });
    /// CliAliases::new().alias_with("--on", &power, Power { onn: true });
    /// ```
    ///
    /// ```compile_fail
    /// # use acid_cat_core::{Capability, cli::CliAliases};
    /// # #[derive(serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
    /// # struct Power { on: bool }
    /// let power = Capability::<()>::new("power.set", "Turn the power on or off.")
    ///     .input::<Power>()
    ///     .run(|_: Power, _| async { Ok(()) });
    /// CliAliases::new().alias_with("--on", &power, Power { on: "yes" });
    /// ```
    ///
    /// A definition with no input takes no fixed input:
    ///
    /// ```compile_fail
    /// # use acid_cat_core::{Capability, cli::CliAliases};
    /// let ping = Capability::<()>::new("ping", "Ping.").run(|(), _| async { Ok(()) });
    /// CliAliases::new().alias_with("loud", &ping, acid_cat_core::NoInput);
    /// ```
    pub fn alias_with<Of: Aliased<Input: Serialize>>(
        mut self,
        name: impl Into<String>,
        of: &Of,
        fixed: Of::Input,
    ) -> Self {
        let name = name.into();
        let (member, id) = of.alias_of();
        match serde_json::to_value(fixed) {
            Ok(Value::Object(mut input)) => {
                input.retain(|_, value| !value.is_null());
                self.aliases
                    .insert(name, json!({ member: id, "input": input }));
            }
            _ => self.problems.push(format!(
                "the fixed input of the alias {name} must serialize to a JSON object"
            )),
        }
        self
    }

    /// The alias that runs when the program gets no arguments. It must be a command alias, and a target has one at most.
    pub fn alias_default(self, name: impl Into<String>, of: &impl Aliased) -> Self {
        let name = name.into();
        let mut aliases = self.alias(name.clone(), of);
        aliases.defaults.push(name);
        aliases
    }

    /// The default alias, with a fixed input as in [`CliAliases::alias_with`].
    pub fn alias_default_with<Of: Aliased<Input: Serialize>>(
        self,
        name: impl Into<String>,
        of: &Of,
        fixed: Of::Input,
    ) -> Self {
        let name = name.into();
        let mut aliases = self.alias_with(name.clone(), of, fixed);
        aliases.defaults.push(name);
        aliases
    }

    pub(crate) fn into_options(self) -> Result<Value, Vec<String>> {
        let mut options = Map::new();
        options.insert("aliases".into(), Value::Object(self.aliases));
        let mut problems = self.problems;
        match self.defaults.as_slice() {
            [] => {}
            [name] if name.starts_with("--") => {
                problems.push(format!(
                    "the default alias {name} is a flag alias. Make it a command alias"
                ));
            }
            [name] => {
                options.insert("default".into(), Value::String(name.clone()));
            }
            names => {
                problems.push(format!(
                    "the aliases {} are all default aliases. Give one at most",
                    names.join(", ")
                ));
            }
        }
        if problems.is_empty() {
            Ok(Value::Object(options))
        } else {
            Err(problems)
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AliasKind {
    Capability,
    Event,
}

impl AliasKind {
    fn catalog_member(self) -> &'static str {
        match self {
            AliasKind::Capability => "capabilities",
            AliasKind::Event => "events",
        }
    }
}

#[derive(Clone, Debug)]
struct Alias {
    name: String,
    kind: AliasKind,
    id: String,
    fixed_input: Option<Map<String, Value>>,
}

struct Aliases {
    /// The aliases, in code point order of their names. An alias that breaks a rule is not here.
    aliases: Vec<Alias>,
    default: Option<Alias>,
    errors: Vec<String>,
}

/// Where the command line writes, and the token that an interrupt cancels.
pub struct CliIo {
    pub stdout: Box<dyn FnMut(&str) + Send>,
    pub stderr: Box<dyn FnMut(&str) + Send>,
    /// Cancelled by an interrupt. It cancels the call or the subscription.
    pub cancel: CancellationToken,
    /// The form of the output that the arguments and [`CliOptions::output`] choose. [`run_cli`] sets it before it
    /// runs a command of the application.
    pub form: OutputForm,
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
            form: OutputForm::Json,
        }
    }
}

/// The work of a command of the application: the arguments after its name, the io and the services. The arguments
/// come unchanged: the command line reads output flags only before the name. `io.form` is the chosen form. The result
/// is the exit code.
pub type CommandRun<C> =
    Arc<dyn for<'a> Fn(Vec<String>, &'a mut CliIo, Arc<C>) -> BoxFuture<'a, i32> + Send + Sync>;

pub struct CliCommand<C> {
    pub name: String,
    /// The text that the help gives for the command.
    pub description: String,
    pub run: CommandRun<C>,
}

pub struct CliOptions<C> {
    pub name: String,
    pub version: String,
    /// The target that the command line serves. The default is `cli`.
    pub target: String,
    /// The text at the top of the help. The default is the description of the application, then `name`.
    pub description: Option<String>,
    /// The commands of the application. The name of each one must not be `call`, `list`, `watch`, the name of
    /// another command of the application, the first word of a command alias, or the first word of the command of a
    /// capability.
    pub commands: Vec<CliCommand<C>>,
    /// The HTTP surface of the application in another process or on another machine. With it, the command line
    /// sends each call and each subscription to that server. The commands still come from the catalog of the target `target` in
    /// this program. Serve the HTTP surface with a target that has the same capabilities and events, for
    /// example the target `cli`.
    pub remote: Option<HttpClient>,
    /// The human form of the output: its flags, its default and its formats. With `None`, the command line writes
    /// JSON only. [`run_cli`] gives an error if the name of an output flag is not valid, is in two output flags, or is
    /// the name of another flag: `--help`, `--version`, `--cursor`, `--max-age-ms`, a flag alias, or a flag of the
    /// input of a capability or an event of the target.
    pub output: Option<CliOutput>,
    /// The form that [`OutputDefault::Auto`] gives. With `None`, [`run_cli`] gives JSON, and [`cli_main`] and
    /// [`run_cli_process`] choose with [`output_form`] from standard output and the environment.
    pub auto_form: Option<OutputForm>,
    /// Color in the human form. With `None`, [`run_cli`] writes no color, and [`cli_main`] and [`run_cli_process`]
    /// write color when standard output is a terminal and `NO_COLOR` is unset or empty.
    pub color: Option<bool>,
    /// The layout of a result, a failure and the output of `list` in the JSON form: many lines with an indent of 2, or
    /// one line. With `None`, [`run_cli`] writes one line, and [`cli_main`] and [`run_cli_process`] write many lines
    /// when standard output is a terminal.
    pub pretty: Option<bool>,
}

impl<C> CliOptions<C> {
    pub fn new(name: impl Into<String>, version: impl Into<String>) -> Self {
        CliOptions {
            name: name.into(),
            version: version.into(),
            target: "cli".into(),
            description: None,
            commands: Vec::new(),
            remote: None,
            output: None,
            auto_form: None,
            color: None,
            pretty: None,
        }
    }

    /// Turn on the human form of the output.
    pub fn output(mut self, output: CliOutput) -> Self {
        self.output = Some(output);
        self
    }

    /// Send each call and each subscription to the HTTP surface of a server.
    pub fn remote(mut self, client: HttpClient) -> Self {
        self.remote = Some(client);
        self
    }
}

enum Provider<C> {
    Local(Session<C>),
    Remote(HttpClient),
}

impl<C: Send + Sync + 'static> Provider<C> {
    async fn invoke(&self, id: &str, input: Value, cancel: &CancellationToken) -> Outcome {
        match self {
            Provider::Local(session) => session.invoke(id, input, cancel).await,
            Provider::Remote(client) => tokio::select! {
                biased;
                () = cancel.cancelled() => Outcome::CallFailure(CallFailure::cancelled()),
                outcome = client.invoke(id, &input) => outcome,
            },
        }
    }

    async fn availability(
        &self,
        ids: &[String],
        cancel: &CancellationToken,
    ) -> Result<Vec<Availability>, CallFailure> {
        match self {
            Provider::Local(session) => Ok(ids
                .iter()
                .map(|id| session.availability(id).unwrap_or(Availability::Available))
                .collect()),
            Provider::Remote(client) => {
                let served = tokio::select! {
                    biased;
                    () = cancel.cancelled() => return Err(CallFailure::cancelled()),
                    served = client.capabilities() => served?,
                };
                Ok(ids
                    .iter()
                    .map(|id| {
                        served.iter().find(|(each, _)| each == id).map_or_else(
                            || {
                                Availability::unavailable(
                                    "The server does not serve this capability.",
                                )
                            },
                            |(_, availability)| availability.clone(),
                        )
                    })
                    .collect())
            }
        }
    }

    async fn subscribe(
        &self,
        id: &str,
        input: Value,
        options: SubscribeOptions,
    ) -> Result<Watching, CallFailure> {
        match self {
            Provider::Local(session) => {
                session
                    .subscribe(id, input, options)
                    .map(|occurrences| Watching {
                        ended: occurrences.ended().boxed(),
                        occurrences: occurrences.into_stream(),
                    })
            }
            Provider::Remote(client) => {
                let max_age_ms = match options.max_age_ms {
                    Some(value) if !crate::session::is_max_age_ms(value) => {
                        return Err(CallFailure::new(
                            Kind::InvalidInput,
                            "maxAgeMs must be an integer that is 0 or more.",
                        ));
                    }
                    other => other.map(|value| value as u64),
                };
                tokio::select! {
                    biased;
                    () = options.cancel.cancelled() => Err(CallFailure::new(Kind::Cancelled, "The subscription was cancelled.")),
                    stream = client.subscribe(id, &input, options.cursor.as_deref(), max_age_ms) => stream,
                }
                .map(|occurrences| Watching { occurrences, ended: futures::future::ready(()).boxed() })
            }
        }
    }
}

/// Run the command line as the main program, with the arguments of the process, and exit with its exit code. An
/// interrupt (`SIGINT`) cancels the call or the subscription. If the process has not exited [`INTERRUPT_GRACE`]
/// after the interrupt, or at a second interrupt, it exits with code 130.
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
/// call or the subscription. If the process has not exited [`INTERRUPT_GRACE`] after the interrupt, or at a second
/// interrupt, it exits with code 130. The result is the exit code.
pub async fn run_cli_process<C: Send + Sync + 'static>(
    app: Arc<Application<C>>,
    context: Arc<C>,
    mut options: CliOptions<C>,
    args: Vec<String>,
) -> i32 {
    let is_terminal = std::io::stdout().is_terminal();
    let env = |name: &str| std::env::var(name).ok();
    options
        .auto_form
        .get_or_insert_with(|| output_form(is_terminal, env));
    options
        .color
        .get_or_insert_with(|| output_color(is_terminal, env));
    options.pretty.get_or_insert(is_terminal);
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

fn listen_for_interrupt(cancel: CancellationToken) {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        if let Ok(mut interrupts) = signal(SignalKind::interrupt()) {
            tokio::spawn(async move {
                if interrupts.recv().await.is_some() {
                    interrupted(&cancel);
                    if interrupts.recv().await.is_some() {
                        std::process::exit(exit::CANCELLED);
                    }
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
            interrupted(&cancel);
            if tokio::signal::ctrl_c().await.is_ok() {
                std::process::exit(exit::CANCELLED);
            }
        }
    });
}

fn interrupted(cancel: &CancellationToken) {
    cancel.cancel();
    // A thread, not a task: the runtime drops its tasks when it shuts down, and a capability can block the threads
    // of the runtime.
    std::thread::spawn(|| {
        std::thread::sleep(INTERRUPT_GRACE);
        std::process::exit(exit::CANCELLED);
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

/// Run the command line with arguments. The result is the exit code (spec/surfaces/cli.md#outcomes), or a rule of
/// the commands that the application breaks.
pub async fn run_cli<C: Send + Sync + 'static>(
    app: &Arc<Application<C>>,
    context: Arc<C>,
    options: &CliOptions<C>,
    args: &[String],
    io: &mut CliIo,
) -> Result<i32, String> {
    let catalog = app.target_catalog(&options.target);
    let provider = match &options.remote {
        None => Provider::Local(Session::open(app, &options.target, context.clone())),
        Some(client) => Provider::Remote(client.clone()),
    };
    let local = match &provider {
        Provider::Local(session) => Some(session.clone()),
        Provider::Remote(_) => None,
    };
    let _close = crate::remote::OnDrop(move || {
        if let Some(session) = &local {
            session.close();
        }
    });
    let ids_of = |member: &str| -> Vec<String> {
        catalog
            .get(member)
            .and_then(Value::as_object)
            .map(|entries| entries.keys().cloned().collect())
            .unwrap_or_default()
    };
    let capability_ids = ids_of("capabilities");
    let event_ids = ids_of("events");
    let types = catalog
        .get("$defs")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let commands: Vec<(String, Vec<String>)> = capability_ids
        .iter()
        .map(|id| (id.clone(), id.split('.').map(str::to_owned).collect()))
        .collect();
    let paths: Vec<Vec<String>> = commands.iter().map(|(_, path)| path.clone()).collect();
    for (_, path) in &commands {
        if GENERIC_COMMANDS.contains(&path[0].as_str()) {
            return Err(filled(
                GENERIC_COMMAND_MESSAGE,
                &[("command", &path.join(" "))],
            ));
        }
        if let Some((_, longer)) = commands
            .iter()
            .find(|(_, other)| other.len() > path.len() && other.starts_with(path))
        {
            return Err(filled(
                SHARED_PREFIX_MESSAGE,
                &[("command", &path.join(" ")), ("longer", &longer.join(" "))],
            ));
        }
    }
    for id in &event_ids {
        let input = catalog
            .pointer(&format!("/events/{id}/input"))
            .map(|input| cli_input_schema(input, &types));
        if let Some(flag) = resume_words().find(|flag| {
            input
                .as_ref()
                .and_then(|input| input.get("properties"))
                .and_then(|properties| properties.get(*flag))
                .is_some()
        }) {
            return Err(filled(
                RESUME_PROPERTY_MESSAGE,
                &[("id", id.as_str()), ("flag", flag)],
            ));
        }
    }
    let Aliases {
        aliases,
        default: default_alias,
        errors: alias_errors,
    } = cli_aliases(&catalog, &options.target);
    if !alias_errors.is_empty() {
        return Err(alias_errors.join("\n"));
    }
    let no_formats = CliFormats::new();
    let formats = options
        .output
        .as_ref()
        .map_or(&no_formats, |output| &output.formats);
    let format_errors = formats.problems(&options.target, &capability_ids, &event_ids);
    if !format_errors.is_empty() {
        return Err(format_errors.join("\n"));
    }
    if let Some(output) = &options.output {
        let output_errors = output.problems(&taken_flags(&catalog, &aliases));
        if !output_errors.is_empty() {
            return Err(output_errors.join("\n"));
        }
    }
    let mut taken: Vec<String> = GENERIC_COMMANDS
        .iter()
        .map(|name| (*name).to_owned())
        .chain(commands.iter().map(|(_, path)| path[0].clone()))
        .chain(
            aliases
                .iter()
                .map(|alias| leading_word(&alias.name).to_owned()),
        )
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
        catalog
            .get("capabilities")
            .and_then(|capabilities| capabilities.get(id))
            .cloned()
            .unwrap_or_else(|| json!({}))
    };
    let schema_of = |entry: &Value| {
        entry
            .get("input")
            .map(|input| cli_input_schema(input, &types))
    };
    let usage_of = |id: &str| usage(&options.name, id, schema_of(&capability(id)).as_ref());
    let alias_usage_of =
        |alias: &Alias| alias_usage(&options.name, alias, alias_input(&catalog, alias).as_ref());
    let alias_usages = |kind: AliasKind, id: &str| -> Vec<String> {
        aliases
            .iter()
            .filter(|alias| alias.kind == kind && alias.id == id)
            .map(alias_usage_of)
            .collect()
    };
    let result: Result<i32, UsageError> = async {
        let (form, args) = match &options.output {
            None => (OutputForm::Json, output::program_arguments(args).to_vec()),
            Some(output) => {
                let command_names: Vec<&str> = options
                    .commands
                    .iter()
                    .map(|command| command.name.as_str())
                    .collect();
                output
                    .decide(args, &command_names, || {
                        options.auto_form.unwrap_or_default()
                    })
                    .map_err(|(code, message)| usage_error(message, code))?
            }
        };
        let printer = Printer {
            form,
            formats,
            ui: CliUi::new(options.color.unwrap_or(false)),
            pretty: options.pretty.unwrap_or(false),
        };
        let printer = &printer;
        let args = args_with_default_alias(&args, default_alias.as_ref(), &aliases);
        let args = args.as_slice();
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
                if !event_ids.is_empty() {
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
                if !aliases.is_empty() {
                    lines.push(String::new());
                    lines.push("Aliases:".into());
                    lines.extend(aliases.iter().map(|alias| {
                        let usage = alias_usage_of(alias);
                        format!("  {}", &usage[options.name.len() + 1..])
                    }));
                }
                let output_lines = options
                    .output
                    .as_ref()
                    .map(CliOutput::help_lines)
                    .unwrap_or_default();
                if !output_lines.is_empty() {
                    lines.push(String::new());
                    lines.push("Output:".into());
                    lines.extend(output_lines.iter().map(|line| format!("  {line}")));
                }
                (io.stdout)(&lines.join("\n"));
                Ok(exit::VALUE)
            }
            Some("--version" | "-v") => {
                (io.stdout)(&options.version);
                Ok(exit::VALUE)
            }
            Some("list") => {
                let availability = match provider.availability(&capability_ids, &io.cancel).await {
                    Ok(availability) => availability,
                    Err(failure) => return Ok(printer.call_failure(io, &failure)),
                };
                let mut entries = Vec::new();
                let mut capability_rows = Vec::new();
                let mut event_rows = Vec::new();
                for (id, available) in capability_ids.iter().zip(availability) {
                    let entry = capability(id);
                    let description = entry
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    capability_rows.push([
                        id.replace('.', " "),
                        match &available {
                            Availability::Available => description.to_owned(),
                            Availability::Unavailable { reason } => {
                                format!("{description} (unavailable: {reason})")
                            }
                        },
                    ]);
                    let mut item = Map::new();
                    item.insert("kind".into(), json!("capability"));
                    item.insert("id".into(), json!(id));
                    item.insert(
                        "description".into(),
                        entry.get("description").cloned().unwrap_or(Value::Null),
                    );
                    item.extend(available.members());
                    item.insert("usage".into(), json!(usage_of(id)));
                    let usages = alias_usages(AliasKind::Capability, id);
                    if !usages.is_empty() {
                        item.insert("aliases".into(), json!(usages));
                    }
                    entries.push(Value::Object(item));
                }
                for id in &event_ids {
                    let event = catalog
                        .get("events")
                        .and_then(|events| events.get(id.as_str()))
                        .cloned()
                        .unwrap_or_default();
                    event_rows.push([
                        format!("watch {id}"),
                        event
                            .get("description")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                    ]);
                    let mut item = Map::new();
                    item.insert("kind".into(), json!("event"));
                    item.insert("id".into(), json!(id));
                    item.insert(
                        "description".into(),
                        event.get("description").cloned().unwrap_or(Value::Null),
                    );
                    item.insert(
                        "usage".into(),
                        json!(event_usage(&options.name, id, schema_of(&event).as_ref())),
                    );
                    let usages = alias_usages(AliasKind::Event, id);
                    if !usages.is_empty() {
                        item.insert("aliases".into(), json!(usages));
                    }
                    entries.push(Value::Object(item));
                }
                if printer.form == OutputForm::Human {
                    (io.stdout)(&human_list(&capability_rows, &event_rows));
                } else {
                    (io.stdout)(&printer.json(&entries));
                }
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
                    let failure = if io.cancel.is_cancelled() {
                        CallFailure::cancelled()
                    } else if !capability_ids.contains(id) {
                        CallFailure::new(
                            Kind::UnknownCapability,
                            format!("There is no capability {id}."),
                        )
                    } else {
                        match provider
                            .availability(std::slice::from_ref(id), &io.cancel)
                            .await
                        {
                            Err(failure) => failure,
                            Ok(availability) => match availability.into_iter().next() {
                                Some(Availability::Unavailable { reason }) => {
                                    CallFailure::new(Kind::Unavailable, reason)
                                }
                                _ => CallFailure::new(Kind::InvalidInput, "The input is not JSON."),
                            },
                        }
                    };
                    return Ok(printer.call_failure(io, &failure));
                };
                let outcome = provider.invoke(id, input, &io.cancel).await;
                Ok(printer.outcome(io, id, &outcome))
            }
            Some("watch") => {
                watch(
                    &provider,
                    printer,
                    &catalog,
                    &types,
                    &options.name,
                    &args[1..],
                    io,
                )
                .await
            }
            Some(_)
                if let AliasOfArgs::UnknownCommand(unknown) =
                    alias_of_args(args, &aliases, &paths) =>
            {
                Err(usage_error(
                    format!("There is no command {}.", unknown.join(" ")),
                    exit::UNKNOWN_CAPABILITY,
                ))
            }
            Some(_)
                if let AliasOfArgs::Alias { alias, words } =
                    alias_of_args(args, &aliases, &paths) =>
            {
                run_alias(
                    &provider,
                    printer,
                    &catalog,
                    alias,
                    &options.name,
                    &args[words..],
                    io,
                )
                .await
            }
            Some(name) if options.commands.iter().any(|command| command.name == name) => {
                let command = options
                    .commands
                    .iter()
                    .find(|command| command.name == name)
                    .map(|command| command.run.clone());
                match command {
                    Some(run) => {
                        io.form = form;
                        Ok(run(args[1..].to_vec(), io, context.clone()).await)
                    }
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
                    let shared = (1..=args.len()).rev().find_map(|length| {
                        let (prefix, rest) = args.split_at(length);
                        command_list(
                            prefix,
                            commands.iter().map(|(id, path)| (path, usage_of(id))),
                        )
                        .map(|list| (list, rest))
                    });
                    return match shared {
                        Some((list, rest)) if is_help(rest) => {
                            (io.stdout)(&list);
                            Ok(exit::VALUE)
                        }
                        Some((list, _)) => Err(usage_error(list, exit::UNKNOWN_CAPABILITY)),
                        None => {
                            let words: Vec<&str> = args
                                .iter()
                                .map(String::as_str)
                                .filter(|arg| !arg.starts_with('-'))
                                .collect();
                            Err(usage_error(
                                format!("There is no command {}.", words.join(" ")),
                                exit::UNKNOWN_CAPABILITY,
                            ))
                        }
                    };
                };
                let entry = capability(id);
                let schema = schema_of(&entry).unwrap_or_else(|| json!({ "type": "object" }));
                let flags = &args[path.len()..];
                if is_help(flags) {
                    (io.stdout)(&help(&usage_of(id), description_of(&entry)));
                    return Ok(exit::VALUE);
                }
                let input = parse_flags(flags, &schema)?;
                let outcome = provider.invoke(id, Value::Object(input), &io.cancel).await;
                Ok(printer.outcome(io, id, &outcome))
            }
        }
    }
    .await;
    Ok(result.unwrap_or_else(|error| {
        (io.stderr)(&error.message);
        error.code
    }))
}

async fn run_alias<C: Send + Sync + 'static>(
    provider: &Provider<C>,
    printer: &Printer<'_>,
    catalog: &Value,
    alias: &Alias,
    program: &str,
    args: &[String],
    io: &mut CliIo,
) -> Result<i32, UsageError> {
    let entry = catalog
        .get(alias.kind.catalog_member())
        .and_then(|entries| entries.get(alias.id.as_str()))
        .cloned()
        .unwrap_or_default();
    let schema = alias_input(catalog, alias);
    if is_help(args) {
        let usage = alias_usage(program, alias, schema.as_ref());
        (io.stdout)(&help(&usage, description_of(&entry)));
        return Ok(exit::VALUE);
    }
    let schema = schema.unwrap_or_else(no_flags);
    let is_event = alias.kind == AliasKind::Event;
    let Resume {
        flags: args,
        cursor,
        max_age_ms,
    } = if is_event {
        resume_flags(args)?
    } else {
        Resume {
            flags: args.to_vec(),
            cursor: None,
            max_age_ms: None,
        }
    };
    let input = if schema.get("properties").is_some() {
        let mut input = alias.fixed_input.clone().unwrap_or_default();
        input.extend(parse_flags(&args, &schema)?);
        Value::Object(input)
    } else {
        if let Some(extra) = args.get(1) {
            return Err(usage_error(
                format!("Unexpected argument {extra}."),
                exit::INVALID_INPUT,
            ));
        }
        let Ok(input) = serde_json::from_str::<Value>(args.first().map_or("{}", String::as_str))
        else {
            // Text that is not JSON is invalid input. For a call, cancelled and unavailable come first
            // (spec/invocation.md#call-failures).
            let failure = if is_event {
                CallFailure::new(Kind::InvalidInput, "The input is not JSON.")
            } else if io.cancel.is_cancelled() {
                CallFailure::cancelled()
            } else {
                match provider
                    .availability(std::slice::from_ref(&alias.id), &io.cancel)
                    .await
                {
                    Err(failure) => failure,
                    Ok(availability) => match availability.into_iter().next() {
                        Some(Availability::Unavailable { reason }) => {
                            CallFailure::new(Kind::Unavailable, reason)
                        }
                        _ => CallFailure::new(Kind::InvalidInput, "The input is not JSON."),
                    },
                }
            };
            return Ok(printer.call_failure(io, &failure));
        };
        input
    };
    match alias.kind {
        AliasKind::Capability => {
            let outcome = provider.invoke(&alias.id, input, &io.cancel).await;
            Ok(printer.outcome(io, &alias.id, &outcome))
        }
        AliasKind::Event => {
            Ok(follow(provider, printer, &alias.id, input, cursor, max_age_ms, io).await)
        }
    }
}

async fn watch<C: Send + Sync + 'static>(
    provider: &Provider<C>,
    printer: &Printer<'_>,
    catalog: &Value,
    types: &Map<String, Value>,
    program: &str,
    args: &[String],
    io: &mut CliIo,
) -> Result<i32, UsageError> {
    let Resume {
        flags,
        cursor,
        max_age_ms,
    } = resume_flags(args)?;
    let Some((id, flags)) = flags.split_first() else {
        return Err(usage_error("Give the id of an event.", exit::INVALID_INPUT));
    };
    let mut input = json!({});
    if let Some(event) = catalog
        .get("events")
        .and_then(|events| events.get(id.as_str()))
    {
        let schema = cli_input_schema(
            event.get("input").unwrap_or(&json!({ "type": "object" })),
            types,
        );
        if is_help(flags) {
            let usage = event_usage(program, id, event.get("input").map(|_| &schema));
            (io.stdout)(&help(&usage, description_of(event)));
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
                    return Ok(printer.call_failure(
                        io,
                        &CallFailure::new(Kind::InvalidInput, "The input is not JSON."),
                    ));
                }
            }
        }
    }
    Ok(follow(provider, printer, id, input, cursor, max_age_ms, io).await)
}

async fn follow<C: Send + Sync + 'static>(
    provider: &Provider<C>,
    printer: &Printer<'_>,
    id: &str,
    input: Value,
    cursor: Option<String>,
    max_age_ms: Option<f64>,
    io: &mut CliIo,
) -> i32 {
    let options = SubscribeOptions {
        cursor,
        max_age_ms,
        cancel: io.cancel.clone(),
    };
    let Watching {
        mut occurrences,
        ended,
    } = match provider.subscribe(id, input, options).await {
        Ok(watching) => watching,
        Err(_) if io.cancel.is_cancelled() => return exit::CANCELLED,
        Err(failure) => return printer.call_failure(io, &failure),
    };
    loop {
        let next = tokio::select! {
            biased;
            () = io.cancel.cancelled() => None,
            next = occurrences.next() => next,
        };
        match next {
            None if io.cancel.is_cancelled() => {
                drop(occurrences);
                ended.await;
                return exit::CANCELLED;
            }
            None => return exit::VALUE,
            Some(Err(failure)) => {
                printer.call_failure(io, &failure);
                return exit::INTERNAL;
            }
            Some(Ok(occurrence)) => printer.occurrence(io, &occurrence),
        }
    }
}

/// The process can exit as soon as the watch returns, before a task of the runtime ends the subscription, so the
/// watch waits for `ended` after an interrupt.
struct Watching {
    occurrences: BoxStream<'static, Result<Occurrence, CallFailure>>,
    ended: BoxFuture<'static, ()>,
}

struct Printer<'a> {
    form: OutputForm,
    formats: &'a CliFormats,
    ui: CliUi,
    pretty: bool,
}

impl Printer<'_> {
    fn json(&self, value: &impl serde::Serialize) -> String {
        if self.pretty {
            serde_json::to_string_pretty(value).unwrap_or_default()
        } else {
            serde_json::to_string(value).unwrap_or_default()
        }
    }

    fn human(&self, io: &mut CliIo, of: Formatted, id: &str, value: &Value) {
        let text = self.formats.render(of, id, value, &self.ui);
        if !text.is_empty() {
            (io.stdout)(&text);
        }
    }

    fn outcome(&self, io: &mut CliIo, id: &str, outcome: &Outcome) -> i32 {
        match (outcome, self.form) {
            (Outcome::Value(Value::Null), OutputForm::Human) => exit::VALUE,
            (Outcome::Value(value), OutputForm::Human) => {
                self.human(io, Formatted::Value, id, value);
                exit::VALUE
            }
            (Outcome::Value(value), OutputForm::Json) => {
                (io.stdout)(&self.json(value));
                exit::VALUE
            }
            (Outcome::Failure(error), OutputForm::Human) => {
                self.human(io, Formatted::Failure, id, error);
                exit::FAILURE
            }
            (Outcome::Failure(error), OutputForm::Json) => {
                (io.stdout)(&self.json(error));
                exit::FAILURE
            }
            (Outcome::CallFailure(failure), _) => self.call_failure(io, failure),
        }
    }

    fn call_failure(&self, io: &mut CliIo, failure: &CallFailure) -> i32 {
        match self.form {
            OutputForm::Human => (io.stderr)(&format!(
                "{} ({}): {}",
                self.ui.error("error"),
                failure.kind.as_str(),
                failure.message
            )),
            OutputForm::Json => (io.stderr)(&failure.to_json().to_string()),
        }
        match failure.kind {
            Kind::UnknownCapability => exit::UNKNOWN_CAPABILITY,
            Kind::InvalidInput => exit::INVALID_INPUT,
            Kind::Unavailable => exit::UNAVAILABLE,
            Kind::Internal => exit::INTERNAL,
            Kind::Cancelled => exit::CANCELLED,
        }
    }

    fn occurrence(&self, io: &mut CliIo, occurrence: &Occurrence) {
        match self.form {
            OutputForm::Human => {
                if occurrence.truncated {
                    (io.stdout)("(some occurrences were lost)");
                }
                self.human(io, Formatted::Payload, &occurrence.name, &occurrence.data);
            }
            OutputForm::Json => (io.stdout)(&occurrence.to_json().to_string()),
        }
    }
}

fn human_list(capabilities: &[[String; 2]], events: &[[String; 2]]) -> String {
    let section = |title: &str, rows: &[[String; 2]]| {
        let rows: Vec<[&str; 2]> = rows
            .iter()
            .map(|[first, second]| [first.as_str(), second.as_str()])
            .collect();
        let rows: Vec<&[&str]> = rows.iter().map(|row| row.as_slice()).collect();
        std::iter::once(title.to_owned())
            .chain(aligned(&rows).into_iter().map(|line| format!("  {line}")))
            .collect::<Vec<_>>()
    };
    let mut lines = section("Capabilities", capabilities);
    if !events.is_empty() {
        lines.extend(section("Events", events));
    }
    lines.join("\n")
}

fn taken_flags(catalog: &Value, aliases: &[Alias]) -> Vec<(String, String)> {
    let mut taken: Vec<(String, String)> = Vec::new();
    let mut take = |name: String, what: String| {
        if !taken.iter().any(|(each, _)| *each == name) {
            taken.push((name, what));
        }
    };
    for (name, what) in RESERVED_FLAGS {
        take(name.to_owned(), what.to_owned());
    }
    for alias in aliases.iter().filter(|alias| alias.name.starts_with("--")) {
        take(alias.name.clone(), format!("the flag alias {}", alias.name));
    }
    let types = object_at(catalog, "$defs");
    for (member, kind) in [("capabilities", "capability"), ("events", "event")] {
        let entries = catalog
            .get(member)
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        for (id, entry) in entries {
            let Some(input) = entry.get("input") else {
                continue;
            };
            let schema = cli_input_schema(input, types);
            let properties = schema.get("properties").and_then(Value::as_object);
            for property in properties.into_iter().flat_map(Map::keys) {
                take(
                    format!("--{property}"),
                    format!("a flag of the {kind} {id}"),
                );
            }
        }
    }
    taken
}

fn split_flag(arg: &str) -> Option<(&str, Option<&str>)> {
    let flag = arg.strip_prefix("--")?;
    Some(match flag.split_once('=') {
        Some((name, value)) => (name, Some(value)),
        None => (flag, None),
    })
}

struct Resume {
    flags: Vec<String>,
    cursor: Option<String>,
    max_age_ms: Option<f64>,
}

fn resume_flags(args: &[String]) -> Result<Resume, UsageError> {
    let mut flags = Vec::new();
    let mut cursor = None;
    let mut max_age_ms = None;
    let mut remaining = args.iter();
    while let Some(arg) = remaining.next() {
        let Some((name, inline)) =
            split_flag(arg).filter(|(name, _)| resume_words().any(|word| word == *name))
        else {
            flags.push(arg.clone());
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
    Ok(Resume {
        flags,
        cursor,
        max_age_ms,
    })
}

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

fn is_help(args: &[String]) -> bool {
    args.iter().any(|arg| arg == "--help" || arg == "-h")
}

fn description_of(entry: &Value) -> &str {
    entry
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

fn help(usage: &str, description: &str) -> String {
    format!("Usage: {usage}\n\n{description}")
}

fn command_list<'a>(
    prefix: &[String],
    capabilities: impl Iterator<Item = (&'a Vec<String>, String)>,
) -> Option<String> {
    let lines: Vec<String> = capabilities
        .filter(|(path, _)| path.len() > prefix.len() && path.starts_with(prefix))
        .map(|(_, usage)| format!("  {usage}"))
        .collect();
    if prefix.is_empty() || lines.is_empty() {
        return None;
    }
    Some(
        std::iter::once("Commands:".to_owned())
            .chain(lines)
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

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

fn is_word(word: &str) -> bool {
    word.starts_with(|first: char| first.is_ascii_lowercase())
        && word.split('-').all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|letter| letter.is_ascii_lowercase() || letter.is_ascii_digit())
        })
}

fn is_alias_name(name: &str) -> bool {
    match name.strip_prefix("--") {
        Some(word) => is_word(word),
        None => name.split(' ').count() <= 2 && name.split(' ').all(is_word),
    }
}

fn cli_aliases(catalog: &Value, target: &str) -> Aliases {
    let mut result = Aliases {
        aliases: Vec::new(),
        default: None,
        errors: Vec::new(),
    };
    let Some(declared) = catalog
        .get("targets")
        .and_then(|targets| targets.get(target))
    else {
        return result;
    };
    let Some(settings) = declared
        .get("options")
        .filter(|options| options.is_object())
        .and_then(|options| options.get("cli"))
    else {
        return result;
    };
    let place = format!("target {target}");
    let Some(settings) = settings.as_object() else {
        result
            .errors
            .push(filled(SETTINGS_NOT_OBJECT_MESSAGE, &[("where", &place)]));
        return result;
    };
    let errors = &mut result.errors;
    let has_cli = declared
        .get("surfaces")
        .and_then(Value::as_array)
        .is_some_and(|surfaces| surfaces.iter().any(|surface| surface == "cli"));
    if !has_cli {
        errors.push(filled(NO_CLI_SURFACE_MESSAGE, &[("where", &place)]));
    }
    let empty = json!({});
    let Some(members) = settings.get("aliases").unwrap_or(&empty).as_object() else {
        errors.push(filled(ALIASES_NOT_OBJECT_MESSAGE, &[("where", &place)]));
        return result;
    };

    let types = object_at(catalog, "$defs");
    let capabilities = object_at(catalog, "capabilities");
    let events = object_at(catalog, "events");
    let paths: Vec<String> = capabilities.keys().map(|id| id.replace('.', " ")).collect();
    let mut names: Vec<&String> = members.keys().collect();
    names.sort();
    let aliases = &mut result.aliases;
    for name in names {
        let mut problem = |template: &str, parts: &[(&str, &str)]| {
            let mut all = vec![("where", place.as_str()), ("name", name.as_str())];
            all.extend_from_slice(parts);
            errors.push(filled(template, &all));
        };
        if !is_alias_name(name) {
            problem(BAD_NAME_MESSAGE, &[]);
            continue;
        }
        let (leading, two_words) = match name.split_once(' ') {
            Some((leading, _)) => (leading, true),
            None => (name.as_str(), false),
        };
        let reserved = if name.starts_with("--") {
            PROGRAM_FLAGS.contains(&name.as_str())
        } else {
            GENERIC_COMMANDS.contains(&leading)
        };
        if reserved {
            let template = if two_words {
                RESERVED_FIRST_WORD_MESSAGE
            } else {
                RESERVED_NAME_MESSAGE
            };
            problem(template, &[]);
            continue;
        }
        if paths.contains(name) {
            problem(COMMAND_PATH_MESSAGE, &[]);
            continue;
        }
        let value = &members[name];
        let (capability, event) = (value.get("capability"), value.get("event"));
        let named = capability.filter(|id| !id.is_null()).or(event);
        let id = match named.and_then(Value::as_str) {
            Some(id) if value.is_object() && !(capability.is_some() && event.is_some()) => id,
            _ => {
                problem(BAD_TARGET_MESSAGE, &[]);
                continue;
            }
        };
        let unknown: Vec<&str> = value
            .as_object()
            .into_iter()
            .flat_map(Map::keys)
            .map(String::as_str)
            .filter(|key| !["capability", "event", "input"].contains(key) && !key.starts_with("x-"))
            .collect();
        if !unknown.is_empty() {
            problem(UNKNOWN_MEMBER_MESSAGE, &[("members", &unknown.join(", "))]);
            continue;
        }
        let (kind, entries, what) = if event.is_some() {
            (AliasKind::Event, events, "an event")
        } else {
            (AliasKind::Capability, capabilities, "a capability")
        };
        let Some(entry) = entries.get(id) else {
            problem(NOT_IN_TARGET_MESSAGE, &[("id", id), ("kind", what)]);
            continue;
        };
        let Some(fixed) = value.get("input") else {
            aliases.push(Alias {
                name: name.clone(),
                kind,
                id: id.to_owned(),
                fixed_input: None,
            });
            continue;
        };
        let Some(fixed) = fixed.as_object() else {
            problem(INPUT_NOT_OBJECT_MESSAGE, &[]);
            continue;
        };
        let properties = entry
            .get("input")
            .and_then(|input| resolve(input, types).get("properties"))
            .and_then(Value::as_object);
        let Some(properties) = properties else {
            problem(NO_PROPERTIES_MESSAGE, &[("id", id)]);
            continue;
        };
        let extra: Vec<&str> = fixed
            .keys()
            .filter(|key| !properties.contains_key(*key))
            .map(String::as_str)
            .collect();
        if !extra.is_empty() {
            problem(
                NOT_A_PROPERTY_MESSAGE,
                &[("members", &extra.join(", ")), ("id", id)],
            );
            continue;
        }
        aliases.push(Alias {
            name: name.clone(),
            kind,
            id: id.to_owned(),
            fixed_input: Some(fixed.clone()),
        });
    }

    let Some(named) = settings.get("default") else {
        return result;
    };
    let fallback = named
        .as_str()
        .and_then(|named| result.aliases.iter().find(|alias| alias.name == named))
        .cloned();
    let command_alias = named
        .as_str()
        .is_some_and(|named| !named.starts_with("--") && members.contains_key(named));
    if !command_alias {
        result
            .errors
            .push(filled(BAD_DEFAULT_MESSAGE, &[("where", &place)]));
        return result;
    }
    let Some(fallback) = fallback else {
        return result;
    };
    let flags = alias_flag_names(catalog, &fallback);
    for reserved in PROGRAM_FLAGS {
        if flags.iter().any(|flag| *flag == reserved[2..]) {
            result.errors.push(filled(
                DEFAULT_HAS_RESERVED_FLAG_MESSAGE,
                &[
                    ("where", &place),
                    ("name", &fallback.name),
                    ("flag", reserved),
                ],
            ));
        }
    }
    for alias in &result.aliases {
        if alias
            .name
            .strip_prefix("--")
            .is_some_and(|flag| flags.iter().any(|each| each == flag))
        {
            result.errors.push(filled(
                FLAG_OF_DEFAULT_MESSAGE,
                &[
                    ("where", &place),
                    ("name", &alias.name),
                    ("default", &fallback.name),
                ],
            ));
        }
    }
    result.default = Some(fallback);
    result
}

fn alias_input(catalog: &Value, alias: &Alias) -> Option<Value> {
    let input = catalog
        .get(alias.kind.catalog_member())
        .and_then(|entries| entries.get(alias.id.as_str()))
        .and_then(|entry| entry.get("input"))?;
    let input = cli_input_schema(input, object_at(catalog, "$defs"));
    Some(alias_schema(&input, alias.fixed_input.as_ref()))
}

fn alias_flag_names(catalog: &Value, alias: &Alias) -> Vec<String> {
    let properties = alias_input(catalog, alias)
        .as_ref()
        .map(|input| {
            object_at(input, "properties")
                .keys()
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let resume = match alias.kind {
        AliasKind::Event => resume_words().map(str::to_owned).collect(),
        AliasKind::Capability => Vec::new(),
    };
    [properties, resume].concat()
}

fn args_with_default_alias(
    args: &[String],
    default_alias: Option<&Alias>,
    aliases: &[Alias],
) -> Vec<String> {
    match (default_alias, args.first()) {
        (None, _) => args.to_vec(),
        (Some(fallback), None) => fallback.name.split(' ').map(str::to_owned).collect(),
        (Some(fallback), Some(head)) => {
            let flag_of_program = PROGRAM_FLAGS.contains(&head.as_str())
                || aliases.iter().any(|alias| alias.name == *head);
            if head.starts_with("--") && !flag_of_program {
                fallback
                    .name
                    .split(' ')
                    .map(str::to_owned)
                    .chain(args.iter().cloned())
                    .collect()
            } else {
                args.to_vec()
            }
        }
    }
}

fn leading_word(name: &str) -> &str {
    name.split(' ').next().unwrap_or(name)
}

enum AliasOfArgs<'a> {
    Alias { alias: &'a Alias, words: usize },
    UnknownCommand(Vec<String>),
    None,
}

fn alias_of_args<'a>(
    args: &[String],
    aliases: &'a [Alias],
    paths: &[Vec<String>],
) -> AliasOfArgs<'a> {
    let starts_args = |words: &[String]| {
        words.len() <= args.len() && words.iter().zip(args).all(|(word, arg)| word == arg)
    };
    if paths.iter().any(|path| starts_args(path)) {
        return AliasOfArgs::None;
    }
    let Some(first) = args.first() else {
        return AliasOfArgs::None;
    };
    let two_words = args.get(1).and_then(|second| {
        let name = format!("{first} {second}");
        aliases.iter().find(|alias| alias.name == name)
    });
    let Some(alias) = two_words.or_else(|| aliases.iter().find(|alias| alias.name == *first))
    else {
        return AliasOfArgs::None;
    };
    let words: Vec<String> = alias.name.split(' ').map(str::to_owned).collect();
    let under: Vec<&Vec<String>> = paths
        .iter()
        .filter(|path| path.len() > words.len() && path.starts_with(&words))
        .collect();
    let next = args.get(words.len());
    if under.iter().any(|path| next == path.get(words.len())) {
        return AliasOfArgs::None;
    }
    let prefix = !under.is_empty();
    let group = two_words.is_none()
        && aliases
            .iter()
            .any(|other| other.name.starts_with(&format!("{first} ")));
    match next {
        Some(next) if (prefix || group) && is_word(next) => {
            AliasOfArgs::UnknownCommand([words, vec![next.clone()]].concat())
        }
        _ => AliasOfArgs::Alias {
            alias,
            words: words.len(),
        },
    }
}

fn no_flags() -> Value {
    json!({ "type": "object", "properties": {} })
}

fn alias_schema(input: &Value, fixed: Option<&Map<String, Value>>) -> Value {
    let (Some(fixed), Some(properties)) =
        (fixed, input.get("properties").and_then(Value::as_object))
    else {
        return input.clone();
    };
    let kept: Map<String, Value> = properties
        .iter()
        .filter(|(name, _)| !fixed.contains_key(*name))
        .map(|(name, property)| (name.clone(), property.clone()))
        .collect();
    let required: Vec<Value> = input
        .get("required")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|name| name.as_str().is_some_and(|name| !fixed.contains_key(name)))
        .cloned()
        .collect();
    let mut schema = input.as_object().cloned().unwrap_or_default();
    schema.remove("required");
    schema.insert("properties".into(), Value::Object(kept));
    if !required.is_empty() {
        schema.insert("required".into(), Value::Array(required));
    }
    Value::Object(schema)
}

fn alias_usage(program: &str, alias: &Alias, input: Option<&Value>) -> String {
    let flags = match input {
        None => Vec::new(),
        Some(input) if input.get("properties").is_none() => vec!["'<json>'".to_owned()],
        Some(input) => cli_flags(input),
    };
    let resume = match alias.kind {
        AliasKind::Event => Some("[--cursor <string>] [--max-age-ms <integer>]".to_owned()),
        AliasKind::Capability => None,
    };
    [program.to_owned(), alias.name.clone()]
        .into_iter()
        .chain(flags)
        .chain(resume)
        .collect::<Vec<_>>()
        .join(" ")
}

fn parse_flags(args: &[String], schema: &Value) -> Result<Map<String, Value>, UsageError> {
    let properties = object_at(schema, "properties");
    let definitions = object_at(schema, "$defs");
    let mut input = Map::new();
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
