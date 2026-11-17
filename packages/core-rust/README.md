# acid-cat-core

The AcidCat core for Rust. crates.io package: `acid-cat-core`.

Serve the capabilities and the events of an application through the [MCP](../../spec/bindings/mcp.md), [HTTP](../../spec/bindings/http.md) and [CLI](../../spec/bindings/cli.md) bindings. The application writes its catalog from its code. The core passes all checks of `acid-cat conform` for these bindings.

```sh
cargo add acid-cat-core
```

The core uses [Tokio](https://tokio.rs). Types give the schemas: an input, a value, a failure or a payload is a type that derives `serde` and `schemars::JsonSchema`. The core validates each input against its JSON Schema before the work starts, and checks each value, failure and payload against its schema.

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

The full example is [`examples/fixture.rs`](examples/fixture.rs): the conformance fixture, with each binding.

## Capabilities

`Capability::new(id, description)` starts a capability. Then:

| Method | Use |
| --- | --- |
| `audience([...])` | The targets that can use the capability |
| `input::<T>()` | The input type. Its schema is the input schema. With no input, the work gets `()` |
| `output::<T>()` | The type of the value. Its schema is the output schema. With no output, the value is `null`, and the work gives `()` |
| `failures::<T>()` | An enum with `#[serde(tag = "_tag")]`. Each variant is one failure, and its name is the tag |
| `read_only()` | A call changes nothing that a client can see |
| `availability(f)` | A `tokio::sync::watch::Receiver<Availability>` for each session, from the services |
| `state(f)` | The [state](../../spec/invocation.md#state): a `tokio::sync::watch::Receiver<T>` for each session, from the services. Its type gives the state schema. `Session::state(id)` observes it |
| `input_schema`, `output_schema`, `failure_schemas` | Give a schema that you write, for example with `serde_json::json!` |
| `run(f)` | The work: `f(input, call)` gives a future of `Result<value, RunError<failure>>` |

The work ends in one of three ways:

- `Ok(value)`: the value.
- `fail(failure)`: a failure of the capability.
- An error, with `?`, a [`Defect`], or a panic: the call failure `internal`. Its message shows no internal data. `App::on_defect` records the cause. The default writes it to standard error.

When a call is cancelled, the core drops the future of the work. `call.cancel_token()` is also cancelled. `call.context()` gives the services, and `call.target()` the target of the session, for example `mcp` or `cli`. A subscription has the same `context()` and `target()`.

An `Option` field that is not required takes the value of its type, not `null`. Add `#[serde(skip_serializing_if = "Option::is_none")]` to the fields of a value. Integers and numbers have no `format` in the catalog.

## Events

`Event::new(id, description)` starts an event. `input::<T>()` and `payload::<T>()` give the schemas. `subscribe(f)` gives the provider: `f(input, subscription)` gives a `Stream` of `Result<Emitted<P>, Defect>`.

- `Emitted::new(data)` is one occurrence. `event_id`, `timestamp`, `cursor` and `truncated` add its other members.
- The end of the stream ends the subscription as complete. An `Err` item, or a panic, ends it with the call failure `internal`.
- When the client cancels the subscription, or the session closes, the core drops the stream.
- `subscription.cursor()` and `subscription.max_age_ms()` tell where to start ([Resuming](../../spec/events.md#resuming)).

## The application

`App::new()` declares the targets with `target(name, bindings)`, or `target_with(name, Target { .. })` for a target with a description or options, then the capabilities and the events. `build()` checks the application, compiles its schemas and writes its catalog. It gives an `Arc<Application<C>>`, or the rules that the application breaks. A schema with a `title`, or a failure, that the application uses in two or more places becomes a shared type in `$defs`, with its title or its tag as its name. `render_catalog()` gives the catalog in canonical form. Write it to a file in a build step, and check it with `acid-cat check`.

`Session::open(&app, target, context)` opens a session for code in the same process: `invoke` calls a capability with an input in its JSON form, and `subscribe` follows an event.

## Bindings

| Binding | Function |
| --- | --- |
| MCP through HTTP | `mcp::McpBinding::new(app, context, McpOptions::new(name, version))`. It serves revision `2026-07-28`, and the `initialize` handshake of earlier revisions. Poll delivery is on. Webhook delivery is on with `McpOptions::webhooks`, and the principal of each request comes from `McpOptions::principal` |
| MCP through stdio | `mcp::serve_stdio(app, context, McpStdioOptions::new(name, version))` |
| HTTP | `http::HttpBinding::new(app, context, HttpOptions::default())` |
| CLI | `cli::cli_main(app, context, CliOptions::new(name, version))`. An interrupt cancels the call or the subscription. With `CliOptions::remote`, it calls a server: see [A command line for a server](#a-command-line-for-a-server) |

The command line has the [aliases](../../spec/bindings/cli.md#aliases) of its target. Give them with `App::cli_aliases(target, CliAliases::new()...)`: `.alias(name, &definition)`, `.alias_with(name, &definition, fixed)` for a fixed input, and `.alias_default(name, &definition)` or `.alias_default_with(name, &definition, fixed)` for the default alias. Each takes a `CapabilityDefinition<C, X>` or an `EventDefinition<C, X>`, where `X` is the type of the input, so bind the definition before you give it to `App::capability` or `App::event`. The fixed input is a value of `X`, for example `.alias_with("--on", &power_set, Power { on: true })`. A property that serializes to `null`, such as an `Option` that is `None`, is not fixed: it stays a flag of the alias. A required property (not an `Option`) is always fixed, because each value of `X` has it. A definition with no input has `X = NoInput`, a type with no serialized form, so `alias_with` gives a type error for it. To keep definitions with different inputs in one list, call `.untyped()` on each. The catalog writes the aliases in `options.cli` of the target. An alias of a capability calls it, and an alias of an event subscribes to it as `watch` does. With no arguments, or with a first flag that is not a flag alias, the command line runs the default alias. An alias that breaks a rule stops the command line when it starts.

### The form of the output

The command line writes JSON for programs. It can also write text for a person: the human form. The human form is off by default. Without `CliOptions::output`, the command line writes JSON only, also on a terminal, and takes no output flag.

To turn the human form on, give `CliOptions::output(CliOutput::new()...)`:

- `.switch(names, form)`: a flag with no value that chooses a form, for example `.switch(["--json"], OutputForm::Json)`.
- `.values(names, values)`: a flag with a value, and the form of each value, for example `.values(["--format", "-f"], [("text", OutputForm::Human), ("json", OutputForm::Json)])`. It takes `--format text`, `--format=text` and `-f text`. A value that is missing or not known is a usage error with exit code 3: `The option --format must be text or json.`
- `.default_form(default)`: the form when the arguments give no output flag: `OutputDefault::Auto` (the default), `OutputDefault::Human` or `OutputDefault::Json`.
- `.formats(formats)`: the formats of the human form (see below).

Each name is `--word` or `-x`, with one letter or digit. An output flag can be anywhere in the arguments. When the arguments give more than one, the last one wins. An output flag can have the name `-h`: then `-h` chooses its form, and `--help` writes the help. The command line stops with an error when it starts if the name of an output flag is not valid, is in two output flags, or is the name of another flag: `--help`, `--version`, `--cursor`, `--max-age-ms`, a flag alias, or a flag of the input of a capability or an event of the view.

With `OutputDefault::Auto`, `cli_main` and `run_cli_process` write the human form only when standard output is a terminal, the environment variable `CI` is not truthy, and no variable of a coding agent is truthy (`AI_AGENT`, `CLAUDECODE`, `CODEX_THREAD_ID`, `CURSOR_AGENT`, `GEMINI_CLI`, `OPENCODE`, `AMP_CURRENT_THREAD_ID`, `AUGMENT_AGENT`, `QWEN_CODE_SESSION_ID`, `PI_CODING_AGENT`, `CRUSH`, `COPILOT_AGENT`). A variable is truthy when it is set and its value is not empty, `0`, `false`, `no` or `off`. `cli::output_form(is_terminal, env)` gives this choice. `run_cli` takes this form from `CliOptions::auto_form`, and the default is JSON.

The human form has color only when standard output is a terminal and `NO_COLOR` is unset or empty. The exit code and the stream of each outcome are the same in each form. Help, usage and usage errors do not change.

| Outcome | Human form |
| --- | --- |
| Value | The format of the value, or the generic layout. A `null` value writes nothing |
| Failure | The format of the failures, or the generic layout of the failure object |
| Call failure | `error (<kind>): <message>` on standard error |
| Occurrence | The format of the payload, or the generic layout of `data`. Before an occurrence with `truncated`, the line `(some occurrences were lost)` |
| `list` | The section `Capabilities`, then the section `Events`, with the command and the description of each one |

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

- Each method takes the definition, as the alias methods do. A `CapabilityDefinition<C, X, O, F>` keeps the type of the value `O` and of the failures `F`, and an `EventDefinition<C, X, P>` keeps the type of the payload `P`. So bind each definition before you give it to `App::capability` or `App::event`. `untyped()` removes these types.
- `failure` takes one function for the failure enum. Match each tag in it.
- A format gets the value decoded again with `serde_json::from_value`, so the type must derive `Deserialize`. When the value does not decode, or the format panics, the command line writes the generic layout. The exit code does not change.
- `ui` is a `CliUi`: `bold`, `dim`, `ok` (green), `warn` (yellow) and `error` (red) style a text, and `table(header, rows)` aligns columns.
- Two formats for the same value of one definition, or a format for a capability or an event that is not in the view of the target, stop the command line when it starts.

The generic layout writes a string as it is, a number as JSON, and an array of scalars as its items joined with `, ` (`(none)` when it is empty). An array of flat objects is a table with a header row. Another array is a list, one `- ` item for each element. An object writes one `key  value` line for each scalar member, with the values aligned, and `key:` with the indented layout for each other member. An empty object is `(empty)`.

`McpBinding` and `HttpBinding` implement `remote::Handler`. `remote::serve(address, routes)` serves handlers by path prefix with hyper. To use another server, give each request to `handle` after `remote::request_body`.

Each request of a remote binding has its own session. With `new`, all requests share one context.

### A context for each request

`HttpBinding::with_request_context(app, make, options)` and `McpBinding::with_request_context(app, make, options)` make a context for each request that passes the screening. `make` gets the head of the request (the method, the URI and the headers), and gives a future of `Result<C, Refusal>`. Use it to authenticate the caller, and to give the work of each capability who calls:

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

- A `Refusal` answers the request with its status, its headers, and the JSON body `{ "message" }`. No capability runs.
- The core drops the context when the session of the request ends: after the answer, or after the stream of a subscription. Release resources in `Drop`.
- Through MCP, a poll lease or a webhook subscription keeps the context of the request that started it, until it ends. Set the `McpOptions::principal` too, from the same caller. A poll lease is keyed by the principal, the event and the input: with no principal, two callers that poll the same event with the same input share one lease, and the second caller reads the occurrences of the session of the first caller.
- `Refusal::new` panics when the status is not from 400 to 599. The answer always has the media type `application/json`.
- The command line and MCP through stdio have one context for the process.

### A command line for a server

The command line can run on another machine than the application. `CliOptions::remote(client)` sends each call and each subscription to the HTTP binding of a server, with `http::HttpClient`:

```rust,ignore
let client = HttpClient::new("http://pi.local:8080/cli")?.header("Authorization", &format!("Bearer {token}"))?;
cli_main(app, context, CliOptions::new("aircon", "1.0.0").remote(client)).await;
```

- The commands, the flags and the usage come from the view of the target in the program. The program and the server use the same application, so that they have the same catalog.
- Serve the HTTP binding at the server with the same target: `HttpOptions { target: "cli".into(), base: "/cli".into(), .. }`. A capability that the server does not serve gives `unknown-capability`.
- `list` gets the availability of each capability from the server.
- An interrupt closes the request, and the server cancels the call or the subscription.
- When the server does not answer, the call failure is `unavailable`, with exit code 4.
- `HttpClient::trust_certificate(pem)` trusts a self-signed certificate for an `https` URL.

## Tests

`cargo test` runs `acid-cat conform` of the repository against the fixture, through MCP over HTTP with the handshake, poll and webhook delivery, MCP over stdio, HTTP, and the command line, in the same process and for a server. It needs `pnpm install` at the root of the repository, and `openssl`. Test with `moon run core-rust:test`.
