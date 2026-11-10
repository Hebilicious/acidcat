# Conformance

Conformance is a test from outside. It uses the catalog and the behavior of each binding. It does not look at the code. Thus an implementation that you write by hand, that you generate, or that uses a library is tested in the same way.

`acid-cat check` tests a catalog. `acid-cat conform` tests a provider and its bindings. Both come from [`@acid-cat/cli`](../packages/cli/README.md).

## Catalog

A catalog conforms if:

- it agrees with [`schemas/catalog.schema.json`](../schemas/catalog.schema.json);
- each target in each audience is in `targets`;
- no id is both the id of a capability and the id of an event;
- each input and each payload is an object, directly or through the type that it refers to;
- each `$ref` refers to a type in `$defs`;
- no schema in a capability or in an event has its own `$defs`;
- each schema is a valid JSON Schema 2020-12 schema.

A catalog that is not in [canonical form](catalog.md#canonical-form) gets a warning. A member that this specification does not define and that does not start with `x-` gets a warning.

## Provider and bindings

A provider and its bindings conform for a target if, through each binding of the target:

- a list of capabilities shows only capabilities in the view of the target;
- a call to an id that is not in the view fails as a call to an unknown id;
- an input that does not agree with its schema fails as `invalid-input`, and the operation does not start;
- values, failures and state agree with their schemas;
- a list of events shows only events in the view of the target, and a subscription to an id that is not in the view fails as an unknown id;
- a subscription with an input that does not agree with its schema fails as `invalid-input`;
- occurrences have the form that the binding defines, and their data agrees with the payload schema;
- each end of a subscription has the form that the binding defines;
- each outcome and each kind of call failure has the form that the binding defines;
- a remote binding rejects requests as [Remote bindings](bindings/README.md#remote-bindings) tells.

## The conformance fixture

[`packages/cli/conformance/fixture.pkl`](../packages/cli/conformance/fixture.pkl) is the catalog that an implementation serves for the tests. Each capability and each event shows one behavior:

| Capability | Behavior |
| --- | --- |
| `fixture.echo` | Returns its input. It is read-only |
| `fixture.refuse` | Returns the failure `Refused` |
| `fixture.crash` | Fails with a defect |
| `fixture.hold` | Holds until `fixture.release` releases its `key`, then returns `{ "key": <key> }`. With a `marker`, it writes a file at that path when it starts to hold. The tests cancel it |
| `fixture.held` | Returns `{ "keys": [...] }`: the keys of the calls to `fixture.hold` that hold now. It is read-only |
| `fixture.release` | Releases the calls to `fixture.hold` that hold a `key` |
| `fixture.hidden` | Only the `app` target can use it |
| `fixture.toggle` | Available only while the switch is on. Its input schema has no properties |
| `fixture.switch.set` | Turns the switch on or off |
| `fixture.flags` | Returns its input. The input has one property for each kind of command-line flag. Only the `cli` target can use it |
| `fixture.signal` | Gives an occurrence of `fixture.watch` with `{ "key", "value" }` to each subscription that watches its `key`. Returns `{ "delivered": <number> }`: the number of these subscriptions |
| `fixture.watching` | Returns `{ "keys": [...] }`: the keys of the subscriptions to `fixture.watch` that are active now, one entry for each subscription. It is read-only |

| Event | Behavior |
| --- | --- |
| `fixture.ticks` | Gives the occurrences with the data `{ "n": 1 }` to `{ "n": <count> }`, then is complete. The `eventId` and the `cursor` of each occurrence are `String(n)`. With a cursor `c`, it starts at `n = c + 1`. It ignores `maxAgeMs`. `count` is an integer from 0 to 100 |
| `fixture.watch` | Gives an occurrence each time that `fixture.signal` gets its `key`. It never ends by itself. With a `marker`, it writes a file at that path when the subscription starts |
| `fixture.broken` | Gives the occurrence `{ "n": 1 }`, then fails with a defect |
| `fixture.secret` | Only the `app` target can use it. It never gives an occurrence |

All the sessions of one provider share the calls that hold and the subscriptions to `fixture.watch`. Thus `fixture.held` and `fixture.watching` through one request give the keys of other requests, and `fixture.signal` reaches the subscriptions of other requests. A provider that serves the CLI binding MUST write the file of a `marker`, for `fixture.hold` and for `fixture.watch`. Other providers MAY ignore `marker`.

The switch MUST be on when the tests start. The implementation gives no MCP instructions of its own, so its MCP instructions are the `description` of the fixture.

## `acid-cat conform`

```sh
acid-cat conform --mcp <url> [--mcp-handshake] --mcp-stdio "<command>" --http <base url> --cli "<command>" --webmcp <page url>
```

Give one or more bindings. `--mcp` tests the MCP binding through HTTP, and `--mcp-stdio` tests it through stdio. For each binding, `acid-cat conform` tests the rules above. It uses the official MCP client for MCP, and sends requests that a client never sends to test rejections. With `--mcp-handshake`, it also tests the `initialize` handshake of revision `2025-11-25` through HTTP. For MCP through stdio, it starts the server as a process. It tests the session with revision `2026-07-28` and with the `initialize` handshake of revision `2025-11-25`. It also tests the changes of the tools, `notifications/cancelled`, lines that are not JSON, and the end of standard input. For WebMCP, it opens the page in a browser, gives the page a test host as `modelContext`, and calls the tools that the page registers. For the CLI, it interrupts a call and examines the exit code. For events, through HTTP, MCP with each transport and the CLI, it tests the list of the events, the call failures before the first occurrence, the form, the data and the order of the occurrences, the cursor, each end of a subscription, and cancellation. Through MCP, it also tests `server/discover`, `events/list`, the subscription id of each message, two subscriptions at the same time, and `events/poll`. With `--mcp-handshake`, it tests that `initialize` does not declare the events extension. Through WebMCP, it tests that no event is a tool. Through MCP, with each transport, and through HTTP, property-based tests examine two guarantees of [Invocation](invocation.md#cancellation-and-concurrency) with random sets of calls: each call gets exactly its own outcome, and the cancellation of one call does not change other calls.

The tests wait for states that they can observe, not for times. Before a test cancels a call to `fixture.hold`, it waits until `fixture.held` gives the key of the call. For the CLI, it waits until the marker file exists, then it sends the interrupt. A cancelled call passes only if it ends with the cancellation of its binding:

- through MCP or HTTP: the call failure `cancelled`, or the client stops the call itself;
- through WebMCP: a rejection with the name `AbortError` and the kind `cancelled`;
- through the CLI: the process exits with the code 130.

Through MCP, HTTP and WebMCP, the key of the cancelled call must then leave `fixture.held`. Each call that a test does not cancel must hold until the test releases it, then return its own key.

A test of a subscription to `fixture.watch` waits in the same way. Before it calls `fixture.signal` or cancels the subscription, it waits until `fixture.watching` gives the key of the subscription. For the CLI, it waits until the marker file exists, then it sends the interrupt. Through MCP and HTTP, the key of a cancelled subscription must then leave `fixture.watching`, and the other subscriptions must still get their occurrences. Through the CLI, the process must exit with the code 130.

Each test has one deadline: `--deadline`, in milliseconds, 30 seconds by default. A test that does not settle before its deadline fails with "did not settle". The test then stops its calls, kills the command line that it started, and releases each key that it used. This cleanup has a deadline of the same length, so `acid-cat conform` always ends. The deadline never makes a test pass.

A test that a SHOULD rule fails gives a warning, not an error. Tests that need access to the code, for example of internal logs, are not part of conformance.
