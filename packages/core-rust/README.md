# acid-cat-core

`acid-cat-core` is the AcidCat core for Rust, published on crates.io. Use it to serve your application's capabilities and events through the [MCP](../../spec/bindings/mcp.md), [HTTP](../../spec/bindings/http.md) and [CLI](../../spec/bindings/cli.md) bindings. Your application declares everything in code, and the core writes the catalog from it. The core passes every `acid-cat conform` check for these three bindings.

```sh
cargo add acid-cat-core
```

The core runs on [Tokio](https://tokio.rs). Rust types give the schemas: each input, value, failure and payload is a type that derives `serde` and `schemars::JsonSchema`. The core validates each input against its JSON Schema before the work starts, and checks each value, failure and payload against its schema.

## Example

```rust,no_run
use std::sync::Arc;

use acid_cat_core::{App, Availability, Emitted, fail};
use acid_cat_core::mcp::{McpStdioOptions, serve_stdio};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio::sync::watch;

/// The services of the application.
struct Aircon {
    online: watch::Sender<Availability>,
}

// The capabilities and the events get the services of the application.
type Capability = acid_cat_core::Capability<Aircon>;
type Event = acid_cat_core::Event<Aircon>;

#[derive(Deserialize, JsonSchema)]
struct Temperature {
    #[schemars(range(min = 16, max = 31))]
    celsius: f64,
}

#[derive(Serialize, JsonSchema)]
#[serde(tag = "_tag")]
enum Failures {
    Offline {},
}

#[derive(Serialize, JsonSchema)]
struct Status {
    power: bool,
}

#[tokio::main]
async fn main() {
    let app = App::new()
        .title("Living-room air conditioner")
        .target("mcp", ["mcp"])
        .capability(
            Capability::new("aircon.temperature.set", "Set the target temperature in degrees Celsius.")
                .audience(["mcp"])
                .input::<Temperature>()
                .failures::<Failures>()
                .availability(|aircon: &Aircon| aircon.online.subscribe())
                .run(|Temperature { celsius }, _call| async move {
                    if celsius > 30.0 {
                        return fail(Failures::Offline {});
                    }
                    Ok(())
                }),
        )
        .event(
            Event::new("aircon.status.changed", "The status of the unit changed.")
                .audience(["mcp"])
                .payload::<Status>()
                .subscribe(|(), _subscription| futures::stream::iter([Ok(Emitted::new(Status { power: true }))])),
        )
        .build()
        .expect("the application conforms");

    let aircon = Arc::new(Aircon { online: watch::Sender::new(Availability::Available) });
    serve_stdio(app, aircon, McpStdioOptions::new("aircon", "1.0.0")).await;
}
```

[`examples/fixture.rs`](examples/fixture.rs) is the full example. It is the conformance fixture and uses every binding.

## Capabilities

Start a capability with `Capability::new(id, description)`, then chain these methods:

| Method | Use |
| --- | --- |
| `audience([...])` | The targets that can use the capability |
| `input::<T>()` | The input type. Its schema is the input schema. With no input, the work gets `()` |
| `output::<T>()` | The value's type. Its schema is the output schema. With no output, the value is `null` and the work returns `()` |
| `failures::<T>()` | An enum with `#[serde(tag = "_tag")]`. Each variant is one failure, and the variant name is its tag |
| `read_only()` | A call changes nothing that a client can see |
| `destructive(bool)` | `true`: a call can delete or overwrite something that a client can see. `false`: a call only adds things |
| `idempotent(bool)` | `true`: a second call with the same input has no further effect that a client can see |
| `availability(f)` | Returns a `tokio::sync::watch::Receiver<Availability>` for each session, from the services |
| `state(f)` | The [state](../../spec/invocation.md#state): returns a `tokio::sync::watch::Receiver<T>` for each session, from the services. `T` gives the state schema. Observe it with `Session::state(id)` |
| `input_schema`, `output_schema`, `failure_schemas` | Set a schema that you write yourself, for example with `serde_json::json!` |
| `run(f)` | The work: `f(input, call)` returns a future of `Result<value, RunError<failure>>` |

The work ends in one of three ways:

- `Ok(value)` returns the value.
- `fail(failure)` returns a failure of the capability.
- An error (through `?` or a `Defect`) or a panic becomes the call failure `internal`. Its message shows no internal data. `App::on_defect` records the cause; by default it writes to standard error.

When a call is cancelled, the core drops the work's future and cancels `call.cancel_token()`. `call.context()` gives the services, and `call.target()` gives the session's target, for example `mcp` or `cli`. A subscription has the same `context()` and `target()`.

Two schema details:

- An `Option` field that is not required takes the value of its type, not `null`. On value types, add `#[serde(skip_serializing_if = "Option::is_none")]` to such fields.
- Integers and numbers have no `format` in the catalog.

## Events

Start an event with `Event::new(id, description)`. `input::<T>()` and `payload::<T>()` give the schemas. `subscribe(f)` sets the provider: `f(input, subscription)` returns a `Stream` of `Result<Emitted<P>, Defect>`.

- `Emitted::new(data)` is one occurrence. `event_id`, `timestamp`, `cursor` and `truncated` set its other members.
- When the stream ends, the subscription ends as complete. An `Err` item or a panic ends it with the call failure `internal`.
- When the client cancels the subscription or the session closes, the core drops the stream.
- `subscription.cursor()` and `subscription.max_age_ms()` tell the provider where to start (see [Resuming](../../spec/events.md#resuming)).

## The application

`App::new()` takes the targets, then the capabilities and the events. Declare a target with `target(name, bindings)`, or with `target_with(name, Target { .. })` when it needs a description or options.

`build()` checks the application, compiles its schemas and writes its catalog. It returns an `Arc<Application<C>>`, or the rules that the application breaks. A schema with a `title`, or a failure, that appears in two or more places becomes a shared type in `$defs`, named by its title or its tag.

`render_catalog()` returns the catalog in canonical form. Write it to a file in a build step and check it with `acid-cat check`.

`Session::open(&app, target, context)` opens a session for code in the same process. `invoke` calls a capability with a JSON input, and `subscribe` follows an event.

## Bindings

| Binding | Function |
| --- | --- |
| MCP through HTTP | `mcp::McpBinding::new(app, context, McpOptions::new(name, version))` |
| MCP through stdio | `mcp::serve_stdio(app, context, McpStdioOptions::new(name, version))` |
| HTTP | `http::HttpBinding::new(app, context, HttpOptions::default())` |
| CLI | `cli::cli_main(app, context, CliOptions::new(name, version))` |

MCP through HTTP serves revision `2026-07-28`, plus the `initialize` handshake of earlier revisions. Poll delivery is on. Turn on webhook delivery with `McpOptions::webhooks`. `McpOptions::principal` gives the principal of each request.

### Serving the remote bindings

`McpBinding` and `HttpBinding` implement `remote::Handler`. `remote::serve(address, routes)` serves handlers by path prefix with hyper. To use another server, pass each request through `remote::request_body` and then to `handle`.

Each request to a remote binding gets its own session. With `new`, all requests share one context. To build a context per request, see the next section.

### A context for each request

`HttpBinding::with_request_context(app, make, options)` and `McpBinding::with_request_context(app, make, options)` build a context for each request that passes screening. `make` gets the request head (method, URI and headers) and returns a future of `Result<C, Refusal>`. Use it to authenticate the caller and to tell each capability's work who is calling:

```rust,ignore
let binding = HttpBinding::with_request_context(app, move |parts: &http::request::Parts| {
    let token = parts.headers.get("authorization").and_then(|value| value.to_str().ok()).map(str::to_owned);
    let accounts = accounts.clone();
    async move {
        match accounts.caller(token.as_deref()).await {
            Some(caller) => Ok(Services { caller, accounts }),
            None => Err(Refusal::new(401, "Give a valid token.").header("WWW-Authenticate", "Bearer")),
        }
    }
}, HttpOptions::default());
```

- A `Refusal` answers the request with its status, its headers and the JSON body `{ "message" }`. No capability runs. The response media type is always `application/json`.
- `Refusal::new` panics when the status is outside 400 to 599.
- The core drops the context when the request's session ends: after the answer, or after a subscription's stream ends. Release resources in `Drop`.
- Through MCP, a poll lease or a webhook subscription keeps the context of the request that started it until it ends. Set `McpOptions::principal` from the same caller. A poll lease is keyed by principal, event and input. With no principal, two callers that poll the same event with the same input share one lease, and the second caller reads the occurrences from the first caller's session.
- The command line and MCP through stdio have one context for the whole process.

## Command line

`cli_main` runs the command line and exits the process. `cli::run_cli_process` does the same but returns the exit code instead of exiting.

- An interrupt cancels the call or the subscription. If the process has not exited `cli::INTERRUPT_GRACE` (one second) later, for example because a capability blocks a runtime thread, it exits with 130 and writes nothing more. A second interrupt exits with 130 at once.
- When the command line breaks a rule of the binding, for example two commands with the same path, `cli_main` and `run_cli_process` write the message to standard error and return exit code 5 (`internal`).

### Help

- `--help` after a command's path writes `Usage: ` with its usage, an empty line, and its description. `<alias> --help` and `watch <id> --help` do the same for an alias and an event.
- `--help` after a shared prefix writes `Commands:` and the usage of each command under it, in the order of `list`.
- A shared prefix alone, or followed by arguments that are neither `--help` nor a command's path, writes the same list to standard error with exit code 2.

See [Commands](../../spec/bindings/cli.md#commands) in the CLI binding.

### Aliases

The command line has the [aliases](../../spec/bindings/cli.md#aliases) of its target. Give them with `App::cli_aliases(target, CliAliases::new()...)`:

| Method | Alias |
| --- | --- |
| `.alias(name, &definition)` | An alias |
| `.alias_with(name, &definition, fixed)` | An alias with a fixed input |
| `.alias_default(name, &definition)` | The default alias |
| `.alias_default_with(name, &definition, fixed)` | The default alias with a fixed input |

Each method takes a `CapabilityDefinition<C, X>` or an `EventDefinition<C, X>`, where `X` is the input type. Bind the definition to a variable before you pass it to `App::capability` or `App::event`. The fixed input is a value of `X`, for example `.alias_with("--on", &power_set, Power { on: true })`.

- A command alias has one or two words, for example `.alias("fan", &fan_set)` and `.alias_with("fan high", &fan_set, Fan { speed: FanSpeed::High })`.
- Command aliases with the same first word form a group. If the first two arguments name a two-word alias, that alias runs. Otherwise the one-word alias runs with the remaining arguments. A second argument that is a word but not the second word of an alias in the group, such as `fan medium`, is an unknown command (exit code 2).
- A command alias can be named after a shared prefix, but not after a command's path. `.alias("aircon power", &power_set)` makes `aircon power --on` call `aircon.power.set`, and `aircon power set --on` stays the command. A word after this prefix default that names no command, such as `aircon power nope`, is an unknown command (exit code 2).
- A property that serializes to `null`, such as an `Option` that is `None`, is not fixed and stays a flag of the alias. A required property (not an `Option`) is always fixed, because every value of `X` has it.
- A definition with no input has `X = NoInput`, a type with no serialized form, so `alias_with` is a type error for it.
- To keep definitions with different inputs in one list, call `.untyped()` on each.
- An alias of a capability calls it. An alias of an event subscribes to it, as `watch` does.
- With no arguments, or when the first flag is not a flag alias, the command line runs the default alias.
- The catalog writes the aliases in the target's `options.cli`. An alias that breaks a rule stops the command line when it starts.

### Output for people

The command line writes JSON for programs. It can also write text for a person: the human form. The human form is off by default. Without `CliOptions::output`, the command line writes only JSON, even on a terminal, and takes no output flag.

To turn the human form on, pass `CliOptions::output(CliOutput::new()...)`:

| Method | Use |
| --- | --- |
| `.switch(names, form)` | A flag with no value that picks a form, for example `.switch(["--json"], OutputForm::Json)` |
| `.values(names, values)` | A flag with a value, mapped to a form, for example `.values(["--format", "-f"], [("text", OutputForm::Human), ("json", OutputForm::Json)])`. It accepts `--format text`, `--format=text` and `-f text`. A missing or unknown value is a usage error with exit code 3: `The option --format must be json or text.` |
| `.default_form(default)` | The form when no output flag is given: `OutputDefault::Json` (the default) or `OutputDefault::Auto`. With `Json`, the output is JSON unless an output flag picks the human form |
| `.formats(formats)` | The formats of the human form (see [Formats](#formats)) |

Rules for output flags:

- Each name is `--word`, or `-x` with one letter or digit.
- The command line ignores a first argument `--`, which package runners such as `pnpm` and `npx` pass along.
- An output flag can be anywhere before a later `--`. For a command of the application, it must come before the command name: the command gets the arguments after its name unchanged, and `io.form` holds the chosen form.
- If the arguments give more than one output flag, the last one wins.
- The help lists the output flags under `Output:`.
- An output flag can be named `-h`. Then `-h` picks its form, and `--help` still writes the help.
- The command line stops with an error at start if an output flag name is invalid, appears in two output flags, or matches another flag: `--help`, `--version`, `--cursor`, `--max-age-ms`, a flag alias, or an input flag of a capability or an event in the view.

With `OutputDefault::Auto`, `cli_main` and `run_cli_process` write the human form only when all of these hold:

- standard output is a terminal;
- the environment variable `CI` is not truthy;
- no coding-agent variable is truthy: `AI_AGENT`, `CLAUDECODE`, `CODEX_THREAD_ID`, `CURSOR_AGENT`, `GEMINI_CLI`, `OPENCODE`, `AMP_CURRENT_THREAD_ID`, `AUGMENT_AGENT`, `QWEN_CODE_SESSION_ID`, `PI_CODING_AGENT`, `CRUSH`, `COPILOT_AGENT`.

A variable is truthy when it is set and its value is not empty, `0`, `false`, `no` or `off`. `cli::output_form(is_terminal, env)` makes this choice. `run_cli` takes the form from `CliOptions::auto_form` instead, and defaults to JSON.

The human form uses color only when standard output is a terminal and `NO_COLOR` is unset or empty. Exit codes and the stream of each outcome are the same in both forms. Help, usage and usage errors do not change.

| Outcome | Human form |
| --- | --- |
| Value | The value's format, or the generic layout. A `null` value writes nothing |
| Failure | The failures' format, or the generic layout of the failure object |
| Call failure | `error (<kind>): <message>` on standard error |
| Occurrence | The payload's format, or the generic layout of `data`. Before an occurrence with `truncated`, the line `(some occurrences were lost)` |
| `list` | The section `Capabilities`, then the section `Events`, with each command and its description |

### Formats

Give the formats with `CliOutput::formats(CliFormats::new()...)`:

```rust,ignore
fn power(status: &Status, ui: &CliUi) -> String {
    ui.bold(if status.power { "on" } else { "off" })
}

let formats = CliFormats::new()
    .capability(&status_get, power)
    .failure(&status_get, |failure: &Offline, ui| match failure {
        Offline::Offline {} => ui.error("offline"),
    })
    .event(&status_changed, power);
let output = CliOutput::new()
    .values(["--format", "-f"], [("text", OutputForm::Human), ("json", OutputForm::Json)])
    .switch(["--json"], OutputForm::Json)
    .formats(formats);
cli_main(app, context, CliOptions::new("aircon", "1.0.0").output(output)).await;
```

- Each method takes the definition, like the alias methods. A `CapabilityDefinition<C, X, O, F>` keeps the value type `O` and the failure type `F`. An `EventDefinition<C, X, P>` keeps the payload type `P`. So bind each definition before you pass it to `App::capability` or `App::event`. `untyped()` removes these types.
- `failure` takes one function for the whole failure enum. Match each tag in it.
- A format gets the value decoded again with `serde_json::from_value`, so the type must derive `Deserialize`. When the value does not decode, or the format panics, the command line writes the generic layout. The exit code does not change.
- `ui` is a `CliUi`. `bold`, `dim`, `ok` (green), `warn` (yellow) and `error` (red) style text, and `table(header, rows)` aligns columns.
- Two formats for the same value of one definition, or a format for a capability or event outside the target's view, stop the command line at start.

The generic layout writes:

- a string as it is, and a number as JSON;
- an array of scalars as its items joined with `, `, or `(none)` when empty;
- an array of flat objects as a table with a header row;
- any other array as a list, one `- ` item per element;
- an object as one `key  value` line per scalar member, values aligned, and `key:` followed by the indented layout for each other member;
- an empty object as `(empty)`.

### A command line for a server

The command line can run on a different machine from the application. `CliOptions::remote(client)` sends each call and subscription to a server's HTTP binding through `http::HttpClient`:

```rust,ignore
let client = HttpClient::new("http://pi.local:8080/cli")?.header("Authorization", &format!("Bearer {token}"))?;
cli_main(app, context, CliOptions::new("aircon", "1.0.0").remote(client)).await;
```

- The commands, flags and usage come from the target's view in the local program. Build the program and the server from the same application so that they share one catalog.
- On the server, serve the HTTP binding with the same target: `HttpOptions { target: "cli".into(), base: "/cli".into(), .. }`. A capability that the server does not serve returns `unknown-capability`.
- `list` gets each capability's availability from the server.
- An interrupt closes the request, and the server cancels the call or the subscription.
- When the server does not answer, the call failure is `unavailable`, with exit code 4.
- `HttpClient::trust_certificate(pem)` trusts a self-signed certificate for an `https` URL.

## Tests

Run the tests with `moon run core-rust:test`. It needs `pnpm install` at the repository root, and `openssl`.

`cargo test` runs the repository's `acid-cat conform` against the fixture through every binding: MCP over HTTP (with the handshake, poll delivery and webhook delivery), MCP over stdio, HTTP, and the command line, both in the same process and against a server.
