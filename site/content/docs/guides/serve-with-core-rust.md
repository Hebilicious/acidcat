---
title: Serve with the Rust core
description: Write capabilities and events in Rust with acid-cat-core, and serve them through the MCP, HTTP and CLI surfaces on Tokio.
sidebar:
  order: 24
  label: Rust core
---

`acid-cat-core` is the core for Rust, on [Tokio](https://tokio.rs). It serves capabilities and events through the MCP, HTTP and CLI surfaces, and passes every `acid-cat conform` check for these three surfaces. You declare everything in code, and the core writes the catalog from it.

```sh
cargo add acid-cat-core
```

Each input, value, failure and payload is a Rust type that derives `serde` and `schemars::JsonSchema`. The core checks each one against the schema of its type.

The Rust core has no WebMCP surface, because WebMCP runs in a web page. It has no language surface either: Rust code in the same process opens a `Session` with `Session::open(&app, target, context)`.

## A complete example

This program serves one capability and one event as an MCP server through stdio:

```rust title="main.rs"
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

## Capabilities

`Capability::new(id, description)` starts a capability. Chain these methods:

| Method | Use |
| --- | --- |
| `audience([...])` | The targets that can use the capability |
| `input::<T>()` | The input type. Without it, the work gets `()` |
| `output::<T>()` | The value type. Without it, the value is `null` |
| `failures::<T>()` | An enum with `#[serde(tag = "_tag")]`. Each variant is one failure, and its name is the tag |
| `read_only()`, `destructive(bool)`, `idempotent(bool)` | The hints |
| `availability(f)` | Returns a `watch::Receiver<Availability>` for each session |
| `state(f)` | Returns a `watch::Receiver<T>` for each session |
| `run(f)` | The work: `f(input, call)` returns a future of a `Result` |

The work returns `Ok(value)`, or `fail(failure)` for a failure. An error or a panic becomes the call failure `internal`, with no internal data in its message.

On cancellation, the core drops the future of the work and cancels `call.cancel_token()`. Release resources in `Drop`.

## Events

`Event::new(id, description)` starts an event. `input::<T>()` and `payload::<T>()` give the schemas. `subscribe(f)` returns a `Stream` of `Result<Emitted<P>, Defect>`. The end of the stream completes the subscription. An `Err` item or a panic ends it with `internal`.

## The application and its catalog

`App::new()` takes the targets, then the capabilities and the events. `build()` checks the application and returns the rules that it breaks, if any.

`render_catalog()` returns the catalog in canonical form. Write it to a file at build time, and run `acid-cat check` on it. The air conditioner prints it with `aircon catalog`. This excerpt of `examples/aircon/core-rust/src/main.rs` shows how:

```rust title="main.rs"
Some("catalog") => print!("{}", app.render_catalog()),
```

## Serve each surface

| Surface | Function |
| --- | --- |
| MCP through HTTP | `mcp::McpSurface::new(app, context, McpOptions::new(name, version))` |
| MCP through stdio | `mcp::serve_stdio(app, context, McpStdioOptions::new(name, version))` |
| HTTP | `http::HttpSurface::new(app, context, HttpOptions::default())` |
| CLI | `cli::cli_main(app, context, CliOptions::new(name, version))` |

`McpSurface` and `HttpSurface` are handlers. `remote::serve(address, routes)` serves them by path prefix. The air conditioner serves the HTTP surface of its `cli` target this way, in this excerpt of `examples/aircon/core-rust/src/main.rs`:

```rust title="main.rs"
use acid_cat_core::http::{HttpSurface, HttpOptions};
let cli = HttpSurface::new(
    app,
    unit,
    HttpOptions {
        target: "cli".into(),
        base: "/cli".into(),
        ..HttpOptions::default()
    },
);
let address = args.get(1).map_or("127.0.0.1:0", String::as_str);
let served = acid_cat_core::remote::serve(
    address.parse().expect("an address such as 0.0.0.0:8080"),
    vec![("/cli".into(), Arc::new(cli))],
)
.await
.expect("the server starts");
println!("{}/cli", served.url());
```

Each request gets its own session. `HttpSurface::with_request_context` and `McpSurface::with_request_context` build a context for each request, and can refuse a request with a `Refusal`, for example to authenticate callers.

## The command line

`cli_main` runs the command line and exits the process. `App::cli_aliases(target, CliAliases::new()...)` gives the aliases of a target:

```rust
.alias("fan", &fan_set)
.alias_with("fan high", &fan_set, Fan { speed: FanSpeed::High })
.alias_with("--on", &power_set, Power { on: true })
.alias("aircon power", &power_set) // the prefix default of `aircon power`
```

`CliOptions::output(CliOutput::new()...)` adds a human form, and `CliOptions::remote(client)` makes the command line a client of the HTTP surface of a server.

Run the air conditioner on the Rust core from `examples/aircon`:

```sh
cargo run --manifest-path core-rust/Cargo.toml -- cli aircon fan set --speed high
cargo run --manifest-path core-rust/Cargo.toml -- cli --off
```

## Read more

- The full [`acid-cat-core` README](https://github.com/Hebilicious/acidcat/blob/main/packages/core-rust/README.md): state, per-request context, output for people, formats, and webhook delivery.
- [The air conditioner on the Rust core](/docs/examples/core-rust/), in a code explorer.
