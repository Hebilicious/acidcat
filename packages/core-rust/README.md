# acid-cat-core

`acid-cat-core` is the AcidCat core for Rust, published on crates.io. It serves your application's capabilities and events through the [MCP](../../spec/surfaces/mcp.md), [HTTP](../../spec/surfaces/http.md) and [CLI](../../spec/surfaces/cli.md) surfaces, and to Rust code in the same process through the [Rust surface](../../spec/surfaces/rust.md). You declare everything in code, and the core writes the catalog from it. The core passes every `acid-cat conform` check for these three surfaces.

```sh
cargo add acid-cat-core
```

The core runs on [Tokio](https://tokio.rs). Each input, value, failure and payload is a Rust type that derives `serde` and `schemars::JsonSchema`, and the core checks each one against that type's schema.

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

[`examples/fixture.rs`](examples/fixture.rs), the conformance fixture, uses every surface.

## Capabilities

`Capability::new(id, description)` starts a capability. Chain these methods:

| Method | Use |
| --- | --- |
| `audience([...])` | The targets that can use the capability |
| `input::<T>()` | The input type. Without it, the work gets `()` |
| `output::<T>()` | The value type. Without it, the work returns `()` and the value is `null` |
| `failures::<T>()` | An enum with `#[serde(tag = "_tag")]`. Each variant is one failure, and its name is the tag |
| `read_only()`, `destructive(bool)`, `idempotent(bool)` | The [hints](../../spec/catalog.md#capabilities) |
| `availability(f)` | Returns a `watch::Receiver<Availability>` for each session, from the services |
| `state(f)` | The [state](../../spec/invocation.md#state): returns a `watch::Receiver<T>` for each session. `T` gives the state schema. Read it with `Session::state(id)` |
| `input_schema`, `output_schema`, `failure_schemas` | Set a schema that you write yourself, for example with `serde_json::json!` |
| `run(f)` | The work: `f(input, call)` returns a future of `Result<value, RunError<failure>>` |

The work returns `Ok(value)`, or `fail(failure)` for a failure. An error (through `?` or a `Defect`) or a panic becomes the call failure `internal`, with no internal data in its message. `App::on_defect` records the cause; by default it writes to standard error.

On cancellation, the core drops the work's future and cancels `call.cancel_token()`. `call.context()` gives the services, and `call.target()` the session's target, such as `mcp` or `cli`. A subscription has the same two methods.

An optional `Option` field takes the value of its type, not `null`, so add `#[serde(skip_serializing_if = "Option::is_none")]` to such fields on value types. Integers and numbers have no `format` in the catalog.

## Events

`Event::new(id, description)` starts an event. `input::<T>()` and `payload::<T>()` give the schemas. `subscribe(f)` sets the provider: `f(input, subscription)` returns a `Stream` of `Result<Emitted<P>, Defect>`.

- `Emitted::new(data)` is one occurrence. `event_id`, `timestamp`, `cursor` and `truncated` set its other members.
- The end of the stream completes the subscription. An `Err` item or a panic ends it with `internal`. The core drops the stream when the subscription is cancelled or the session closes. See [Ending](../../spec/events.md#ending).
- `subscription.cursor()` and `subscription.max_age_ms()` tell the provider where to [resume](../../spec/events.md#resuming).

## The application

`App::new()` takes the targets, then the capabilities and events. Declare a target with `target(name, surfaces)`, or `target_with(name, Target { .. })` for a description or options.

`build()` checks the application and returns an `Arc<Application<C>>`, or the rules that it breaks. A schema with a `title`, or a failure, that appears in more than one place becomes a shared type in `$defs`, named by its title or tag.

`render_catalog()` returns the catalog in canonical form. Write it to a file at build time and run `acid-cat check` on it.

`Session::open(&app, target, context)` opens a session in the same process. It serves the [Rust surface](../../spec/surfaces/rust.md), which maps the [programmatic surface](../../spec/surfaces/programmatic.md):

| Method | Use |
| --- | --- |
| `capability_ids()`, `event_ids()`, `catalog()` | The capabilities and the events of the target |
| `invoke(id, input, &cancel)` | A call with an input that is not trusted. It gives an `Outcome`: `Value`, `Failure` or `CallFailure`. `cancel`, or dropping the future, cancels the call |
| `availability(id)`, `availability_changes()` | The latest availability of a capability, and a message after an availability changes. One message can stand for more than one change. The receiver gives `None` when the session closes, or when no availability of the session can change |
| `state(id)` | A `StateWatch`: `snapshot()` and `changed()` |
| `subscribe(id, input, options)` | The `Occurrences` of a subscription, or the call failure before the first occurrence. `next()` gives each occurrence, then the end. `cancel()`, or dropping it, cancels the subscription |
| `closing()`, `close()` | The token that is cancelled when the session starts to close, and the close itself |

## Surfaces

| Surface | Function |
| --- | --- |
| MCP through HTTP | `mcp::McpSurface::new(app, context, McpOptions::new(name, version))` |
| MCP through stdio | `mcp::serve_stdio(app, context, McpStdioOptions::new(name, version))` |
| HTTP | `http::HttpSurface::new(app, context, HttpOptions::default())` |
| CLI | `cli::cli_main(app, context, CliOptions::new(name, version))` |

MCP through HTTP also accepts the [`initialize` handshake of earlier revisions](../../spec/surfaces/mcp.md#earlier-revisions-through-http). Poll delivery is on. `McpOptions::heartbeat` and `McpStdioOptions::heartbeat` (default 15 seconds) set the push heartbeat interval when the client suggests none. A client that suggests `heartbeatMs` in `events/stream` gets a grant from 1 to 60 seconds ([Push](../../spec/surfaces/mcp.md#push)). MCP through HTTP checks the [headers](../../spec/surfaces/mcp.md#headers) of each request of revision `2026-07-28` against its body: `Mcp-Method`, `Mcp-Name`, and an `Mcp-Param-*` header for each property that has `x-mcp-header`. A mismatch gets 400 and `-32020`. To annotate a field, use `#[schemars(extend("x-mcp-header" = "Region"))]`. `McpOptions::webhooks` turns on webhook delivery, and `McpOptions::principal` gives the principal of each request.

### Server Card

`McpSurface` serves an [MCP Server Card](../../spec/surfaces/mcp.md#server-card) at the URL of the server and `/server-card`, for example `/mcp/server-card`. It is on by default: `McpOptions::new` sets `server_card: Some(ServerCard::default())`. `server_card: None` turns it off: a `GET` request to that URL then gets 404.

```rust,ignore
let options = McpOptions {
    server_card: Some(ServerCard::named("com.example/aircon")),
    webhooks: Some(WebhookOptions {
        signing_keys: vec![private_jwk],
        egress_ip_ranges: vec!["203.0.113.0/24".into()],
        ..WebhookOptions::default()
    }),
    ..McpOptions::new("aircon", "1.0.0")
};
```

| Option | Default | Use |
| --- | --- | --- |
| `ServerCard::named(name)`, `ServerCard::name` | From the host of the URL and `McpOptions::name` ([Default name](../../spec/surfaces/mcp.md#default-name)) | The name of the server in a registry. `McpOptions::name` stays the name that `server/discover` gives |
| `ServerCard::description` | The description of the application, else `McpOptions::instructions`, else `McpOptions::name` ([Default description](../../spec/surfaces/mcp.md#default-description)) | |
| `ServerCard::url` | The URL of the request, without `/server-card` | Give the `https` URL when a platform in front of the server ends TLS |
| `WebhookOptions::signing_keys` | None | Private Ed25519 JSON Web Keys that also [sign each webhook request](../../spec/surfaces/mcp.md#webhook). The card gives their public keys. To change keys, give the new key beside the old one |
| `WebhookOptions::egress_ip_ranges` | None | The CIDR ranges from which the server sends, for the card |

The card gives `McpOptions::version`, and the revisions of the `initialize` handshake if `McpOptions::handshake` is `true`. It gives the signing keys and the egress ranges only if webhook delivery is on.

`McpSurface::new` and `McpSurface::with_request_context` panic when an option breaks the [startup rules of the card](../../spec/surfaces/mcp.md#server-card) or of [webhook delivery](../../spec/surfaces/mcp.md#webhook), for example a version range with the card on, or signing keys with `server_card: None`. The defaults never make the surface panic.

### Serving the remote surfaces

`McpSurface` and `HttpSurface` implement `remote::Handler`. `remote::serve(address, routes)` serves handlers by path prefix with hyper. Like the Node.js servers of the TypeScript cores, it closes no idle connection and sends no `Keep-Alive` header, so a client never sends a request on a connection while the server closes it. The client or the proxy in front closes an idle connection. It sends each message of a stream at once (`TCP_NODELAY`). To use another server, pass each request through `remote::request_body`, then to `handle`.

Each request gets its own session. With `new`, requests share one context.

### A context for each request

`HttpSurface::with_request_context(app, make, options)` and `McpSurface::with_request_context(app, make, options)` build a context for each request that passes screening. `make` gets the request head and returns a future of `Result<C, Refusal>`. Use it to authenticate callers:

```rust,ignore
let surface = HttpSurface::with_request_context(app, move |parts: &http::request::Parts| {
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

- A `Refusal` answers with its status, headers and the JSON body `{ "message" }`. No capability runs. `Refusal::new` panics when the status is outside 400 to 599.
- The core drops the context when the request's session ends. Release resources in `Drop`.
- An MCP poll lease or webhook subscription keeps the context of the request that started it until it ends ([Subscriptions that outlive a request](../../spec/surfaces/mcp.md#subscriptions-that-outlive-a-request)). Set `McpOptions::principal` from the same caller: without a principal, two callers that poll the same event with the same input share one [lease](../../spec/surfaces/mcp.md#poll).
- The command line and MCP through stdio have one context for the whole process.

## Command line

`cli_main` runs the command line and exits the process. `cli::run_cli_process` returns the exit code instead. Commands, help, exit codes and interrupts follow the [CLI surface](../../spec/surfaces/cli.md). The grace period after an interrupt is `cli::INTERRUPT_GRACE` (one second). The command line listens for interrupts on a thread with its own runtime, so a call or a subscription that blocks every thread of the runtime cannot hold back an interrupt. A second interrupt exits at once, also when it comes while the cancellation of the first runs. The exit at the end of the grace period runs on the thread `cli::INTERRUPT_GRACE_THREAD`, and the exit at a second interrupt on another thread, so a test can tell them apart. When the application breaks a rule of the surface, for example two commands with the same path, both functions write the message to standard error. `run_cli_process` returns 5, and `cli_main` exits with 5.

### Aliases

`App::cli_aliases(target, CliAliases::new()...)` gives the target's [aliases](../../spec/surfaces/cli.md#aliases):

| Method | Alias |
| --- | --- |
| `.alias(name, &definition)` | An alias |
| `.alias_with(name, &definition, fixed)` | An alias with a fixed input |
| `.alias_default(name, &definition)` | The default alias |
| `.alias_default_with(name, &definition, fixed)` | The default alias with a fixed input |

```rust,ignore
.alias("fan", &fan_set)
.alias_with("fan high", &fan_set, Fan { speed: FanSpeed::High })
.alias_with("--on", &power_set, Power { on: true })
.alias("aircon power", &power_set) // the prefix default of `aircon power`
```

- Each method takes a `CapabilityDefinition<C, X>` or an `EventDefinition<C, X>`, where `X` is the input type. Bind the definition to a variable before you pass it to `App::capability` or `App::event`.
- The fixed input is a value of `X`. A property that serializes to `null`, such as an `Option` that is `None`, is not fixed and stays a flag. A required property is always fixed.
- A definition with no input has `X = NoInput`, so `alias_with` is a type error for it.
- `.untyped()` lets definitions with different inputs share one list.

### Output for people

In the JSON form, a result, a failure and the output of `list` are one line of JSON when standard output is not a terminal, and have an indent of 2 on a terminal. `CliOptions::pretty` chooses the layout: with `None`, `run_cli` writes one line, and `cli_main` and `run_cli_process` choose from standard output.

By default the command line writes only JSON, even on a terminal, and takes no output flag. `CliOptions::output(CliOutput::new()...)` adds the human form:

| Method | Use |
| --- | --- |
| `.switch(names, form)` | A flag with no value, for example `.switch(["--json"], OutputForm::Json)` |
| `.values(names, values)` | A flag with a value, for example `.values(["--format", "-f"], [("text", OutputForm::Human), ("json", OutputForm::Json)])` |
| `.default_form(default)` | The form with no output flag: `OutputDefault::Json` (the default) or `OutputDefault::Auto` |
| `.formats(formats)` | The [formats](#formats) of the human form |

[Output flags](../../model/README.md#output-flags-and-the-automatic-form) has the rules for names, parsing and startup checks. For an application command, the output flag comes before the command name, and `io.form` holds the chosen form. The help lists the output flags under `Output:`.

With `OutputDefault::Auto`, the form is human when standard output is a terminal, `CI` is not truthy, and none of these variables is truthy: `AI_AGENT`, `CLAUDECODE`, `CODEX_THREAD_ID`, `CURSOR_AGENT`, `GEMINI_CLI`, `OPENCODE`, `AMP_CURRENT_THREAD_ID`, `AUGMENT_AGENT`, `QWEN_CODE_SESSION_ID`, `PI_CODING_AGENT`, `CRUSH`, `COPILOT_AGENT`. `cli::output_form(is_terminal, env)` makes this choice. `run_cli` takes the form from `CliOptions::auto_form` instead, and defaults to JSON.

The human form uses color only on a terminal with `NO_COLOR` unset or empty. Exit codes and streams do not change.

| Outcome | Human form |
| --- | --- |
| Value | Its format, or the generic layout. `null` writes nothing |
| Failure | Its format, or the generic layout |
| Call failure | `error (<kind>): <message>` on standard error |
| Occurrence | Its format, or the generic layout of `data`. With `truncated`, the line `(some occurrences were lost)` comes first |
| `list` | The sections `Capabilities` and `Events` |

### Formats

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

- Each method takes a bound definition, which keeps the value, failure or payload type. `untyped()` removes them.
- `failure` takes one function for the whole failure enum.
- The value is decoded with `serde_json::from_value`, so its type must derive `Deserialize`. If decoding fails or the format panics, the command line writes the generic layout.
- `CliUi` styles text with `bold`, `dim`, `ok` (green), `warn` (yellow) and `error` (red), and aligns columns with `table(header, rows)`.
- Two formats for one value, or a format outside the target, stop the command line at start.

The generic layout writes a string as it is and a number as JSON. An array of scalars is joined with `, ` (`(none)` when empty), an array of flat objects is a table, and any other array is a `- ` list. An object is one aligned `key  value` line per scalar member, and `key:` with an indented layout for other members. An empty object is `(empty)`.

### A command line for a server

`CliOptions::remote(client)` makes the command line a [client of a server's HTTP surface](../../spec/surfaces/cli.md#server):

```rust,ignore
let client = HttpClient::new("http://pi.local:8080/cli")?.header("Authorization", &format!("Bearer {token}"))?;
cli_main(app, context, CliOptions::new("aircon", "1.0.0").remote(client)).await;
```

- Build the program and the server from one application, so they share a catalog.
- Serve the HTTP surface with the same target: `HttpOptions { target: "cli".into(), base: "/cli".into(), .. }`.
- `HttpClient::trust_certificate(pem)` trusts a self-signed certificate for an `https` URL.

## Tests

`moon run core-rust:test` runs the tests. It needs `pnpm install` at the repository root, and `openssl`. The tests run `acid-cat conform` against the fixture through every protocol surface, including poll and webhook delivery and the command line against a server.

The heartbeats, poll leases and webhook timers (lifetimes, retries and the wait for each answer) use the clock of Tokio. A test pauses it with `#[tokio::test(start_paused = true)]` and moves it with `tokio::time::advance`, or lets Tokio move it to the next timer when every task waits.
