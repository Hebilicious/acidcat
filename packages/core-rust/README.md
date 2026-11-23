# acid-cat-core

`acid-cat-core` is the AcidCat core for Rust, published on crates.io. It serves your application's capabilities and events through the [MCP](../../spec/bindings/mcp.md), [HTTP](../../spec/bindings/http.md) and [CLI](../../spec/bindings/cli.md) bindings. You declare everything in code, and the core writes the catalog from it. The core passes every `acid-cat conform` check for these three bindings.

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

[`examples/fixture.rs`](examples/fixture.rs), the conformance fixture, uses every binding.

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

`App::new()` takes the targets, then the capabilities and events. Declare a target with `target(name, bindings)`, or `target_with(name, Target { .. })` for a description or options.

`build()` checks the application and returns an `Arc<Application<C>>`, or the rules that it breaks. A schema with a `title`, or a failure, that appears in more than one place becomes a shared type in `$defs`, named by its title or tag.

`render_catalog()` returns the catalog in canonical form. Write it to a file at build time and run `acid-cat check` on it.

`Session::open(&app, target, context)` opens a session in the same process, with `invoke` and `subscribe`.

## Bindings

| Binding | Function |
| --- | --- |
| MCP through HTTP | `mcp::McpBinding::new(app, context, McpOptions::new(name, version))` |
| MCP through stdio | `mcp::serve_stdio(app, context, McpStdioOptions::new(name, version))` |
| HTTP | `http::HttpBinding::new(app, context, HttpOptions::default())` |
| CLI | `cli::cli_main(app, context, CliOptions::new(name, version))` |

MCP through HTTP also accepts the [`initialize` handshake of earlier revisions](../../spec/bindings/mcp.md#earlier-revisions-through-http). Poll delivery is on. `McpOptions::heartbeat` and `McpStdioOptions::heartbeat` (default 15 seconds) set the push heartbeat interval when the client suggests none. A client that suggests `heartbeatMs` in `events/stream` gets a grant from 1 to 60 seconds ([Push](../../spec/bindings/mcp.md#push)). MCP through HTTP checks the [headers](../../spec/bindings/mcp.md#headers) of each request of revision `2026-07-28` against its body: `Mcp-Method`, `Mcp-Name`, and an `Mcp-Param-*` header for each property that has `x-mcp-header`. A mismatch gets 400 and `-32020`. To annotate a field, use `#[schemars(extend("x-mcp-header" = "Region"))]`. `McpOptions::webhooks` turns on webhook delivery, and `McpOptions::principal` gives the principal of each request.

### Server Card

`McpOptions::server_card` serves an [MCP Server Card](../../spec/bindings/mcp.md#server-card) at the URL of the server and `/server-card`, for example `/mcp/server-card`. The default is `None`: a `GET` request to that URL gets 404.

```rust,ignore
let options = McpOptions {
    server_card: Some(ServerCard::new("com.example/aircon")),
    webhooks: Some(WebhookOptions {
        signing_keys: vec![private_jwk],
        egress_ip_ranges: vec!["203.0.113.0/24".into()],
        ..WebhookOptions::default()
    }),
    ..McpOptions::new("aircon", "1.0.0")
};
```

- `ServerCard::new(name)` gives the name of the card, in reverse-DNS form: 3 to 200 characters, and one `/`. `ServerCard::description` gives the description of the card. The default is the description of the application.
- The card gives `McpOptions::version`, and the URL of the server with the scheme and the host of the request. Behind a platform that ends TLS, the server gets `http` requests: give the `https` URL in `ServerCard::url`. It gives `2026-07-28` and, if `McpOptions::handshake` is `true`, the revisions of the `initialize` handshake.
- `WebhookOptions::signing_keys` is a list of private Ed25519 JSON Web Keys: `kty: "OKP"`, `crv: "Ed25519"`, a `kid` that is not empty, and `d`, the base64url of 32 bytes with no padding. The `webhook-signature` header of each webhook request gets one `v1a,` signature for each key, after the `v1,` signatures. The card gives the public key of each key, and never `d`. The core takes the public key from `d`, and does not read `x`. To change keys, give the new key beside the old one.
- `WebhookOptions::egress_ip_ranges` is a list of CIDR ranges, for example `203.0.113.0/24` or `2001:db8::/32`. The card gives them as they are.
- The card gives the keys and the ranges only if webhook delivery is on.

`McpBinding::new` and `McpBinding::with_request_context` panic when an option is not valid: a card name that does not have the reverse-DNS form, a card with no description or a description that is longer than 100 characters, a version that is longer than 255 characters with a card, a card URL that is not an `http` or `https` URL, a signing key of another form, two signing keys with the same `kid`, or an egress range that is not CIDR text.

### Serving the remote bindings

`McpBinding` and `HttpBinding` implement `remote::Handler`. `remote::serve(address, routes)` serves handlers by path prefix with hyper. To use another server, pass each request through `remote::request_body`, then to `handle`.

Each request gets its own session. With `new`, requests share one context.

### A context for each request

`HttpBinding::with_request_context(app, make, options)` and `McpBinding::with_request_context(app, make, options)` build a context for each request that passes screening. `make` gets the request head and returns a future of `Result<C, Refusal>`. Use it to authenticate callers:

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

- A `Refusal` answers with its status, headers and the JSON body `{ "message" }`. No capability runs. `Refusal::new` panics when the status is outside 400 to 599.
- The core drops the context when the request's session ends. Release resources in `Drop`.
- An MCP poll lease or webhook subscription keeps the context of the request that started it until it ends ([Subscriptions that outlive a request](../../spec/bindings/mcp.md#subscriptions-that-outlive-a-request)). Set `McpOptions::principal` from the same caller: without a principal, two callers that poll the same event with the same input share one [lease](../../spec/bindings/mcp.md#poll).
- The command line and MCP through stdio have one context for the whole process.

## Command line

`cli_main` runs the command line and exits the process. `cli::run_cli_process` returns the exit code instead. Commands, help, exit codes and interrupts follow the [CLI binding](../../spec/bindings/cli.md). The grace period after an interrupt is `cli::INTERRUPT_GRACE` (one second). When the application breaks a rule of the binding, for example two commands with the same path, both functions write the message to standard error. `run_cli_process` returns 5, and `cli_main` exits with 5.

### Aliases

`App::cli_aliases(target, CliAliases::new()...)` gives the target's [aliases](../../spec/bindings/cli.md#aliases):

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
- Two formats for one value, or a format outside the target's view, stop the command line at start.

The generic layout writes a string as it is and a number as JSON. An array of scalars is joined with `, ` (`(none)` when empty), an array of flat objects is a table, and any other array is a `- ` list. An object is one aligned `key  value` line per scalar member, and `key:` with an indented layout for other members. An empty object is `(empty)`.

### A command line for a server

`CliOptions::remote(client)` makes the command line a [client of a server's HTTP binding](../../spec/bindings/cli.md#server):

```rust,ignore
let client = HttpClient::new("http://pi.local:8080/cli")?.header("Authorization", &format!("Bearer {token}"))?;
cli_main(app, context, CliOptions::new("aircon", "1.0.0").remote(client)).await;
```

- Build the program and the server from one application, so they share a catalog.
- Serve the HTTP binding with the same target: `HttpOptions { target: "cli".into(), base: "/cli".into(), .. }`.
- `HttpClient::trust_certificate(pem)` trusts a self-signed certificate for an `https` URL.

## Tests

`moon run core-rust:test` runs the tests. It needs `pnpm install` at the repository root, and `openssl`. The tests run `acid-cat conform` against the fixture through every binding, including poll and webhook delivery and the command line against a server.
