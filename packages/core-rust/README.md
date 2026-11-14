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
            Event::new("aircon.status.changed", "The status of the unit changed. The occurrence gives the new status.")
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
| CLI | `cli::cli_main(app, context, CliOptions::new(name, version))`. An interrupt cancels the call or the subscription |

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
- Through MCP, a poll lease or a webhook subscription keeps the context of the request that started it, until it ends.
- The command line and MCP through stdio have one context for the process.

## Tests

`cargo test` runs `acid-cat conform` of the repository against the fixture, through MCP over HTTP with the handshake, poll and webhook delivery, MCP over stdio, HTTP and the command line. It needs `pnpm install` at the root of the repository, and `openssl`. Test with `moon run core-rust:test`.
