# Conformance

Conformance is a test from outside. It uses the catalog and the behavior of each binding. It does not look at the code. Thus an implementation that you write by hand, that you generate, or that uses a library is tested in the same way.

`acid-cat check` tests a catalog. `acid-cat conform` tests a provider and its bindings. Both come from [`@acid-cat/cli`](../packages/cli/README.md).

## Catalog

A catalog conforms if:

- it agrees with [`schemas/catalog.schema.json`](../schemas/catalog.schema.json);
- each target in each audience is in `targets`;
- each input is an object, directly or through the type that it refers to;
- each `$ref` refers to a type in `$defs`;
- no schema in a capability has its own `$defs`;
- each schema is a valid JSON Schema 2020-12 schema.

A catalog that is not in [canonical form](catalog.md#canonical-form) gets a warning. A member that this specification does not define and that does not start with `x-` gets a warning.

## Provider and bindings

A provider and its bindings conform for a target if, through each binding of the target:

- a list of capabilities shows only capabilities in the view of the target;
- a call to an id that is not in the view fails as a call to an unknown id;
- an input that does not agree with its schema fails as `invalid-input`, and the operation does not start;
- values, failures and state agree with their schemas;
- each outcome and each kind of call failure has the form that the binding defines;
- a remote binding rejects requests as [Remote bindings](bindings/README.md#remote-bindings) tells.

## The conformance fixture

[`packages/cli/conformance/fixture.pkl`](../packages/cli/conformance/fixture.pkl) is the catalog that an implementation serves for the tests. Each capability shows one behavior:

| Capability | Behavior |
| --- | --- |
| `fixture.echo` | Returns its input. It is read-only |
| `fixture.refuse` | Returns the failure `Refused` |
| `fixture.crash` | Fails with a defect |
| `fixture.hold` | Holds until `fixture.release` releases its `key`, then returns `{ "key" }`. With a `marker`, it creates the file at that path when it starts to hold. The tests cancel it |
| `fixture.held` | Lists the keys of the calls to `fixture.hold` that hold now. It is read-only |
| `fixture.release` | Releases the calls to `fixture.hold` that hold a key, and returns how many it released |
| `fixture.hidden` | Only the `app` target can use it |
| `fixture.toggle` | Available only while the switch is on. Its input schema has no properties |
| `fixture.switch.set` | Turns the switch on or off |
| `fixture.flags` | Returns its input. The input has one property for each kind of command-line flag. Only the `cli` target can use it |

The calls that hold are the same for all the sessions of one provider, so `fixture.held` through one request lists the calls of other requests. A provider that serves the CLI binding creates the file of a `marker`. Other providers do not have to.

The switch MUST be on when the tests start. The implementation gives no MCP instructions of its own, so its MCP instructions are the `description` of the fixture.

## `acid-cat conform`

```sh
acid-cat conform --mcp <url> --http <base url> --cli "<command>" --webmcp <page url>
```

Give one or more bindings. For each binding, `acid-cat conform` tests the rules above. It uses the official MCP client for MCP, and sends requests that a client never sends to test rejections. For WebMCP, it opens the page in a browser, gives the page a test host as `modelContext`, and calls the tools that the page registers. For the CLI, it interrupts a call and examines the exit code. Through each remote binding, property-based tests examine two guarantees of [Invocation](invocation.md#cancellation-and-concurrency) with random sets of calls: each call gets exactly its own outcome, and the cancellation of one call does not change other calls.

The tests wait for states that they can observe, not for times. Before they cancel a call to `fixture.hold`, they wait until `fixture.held` lists its key, or, for the CLI, until its marker file exists. A cancelled call passes only if the binding gives the call failure `cancelled`, or if the call rejects with the reason that the test gave to its signal. After the cancellation, its key must leave `fixture.held`, and each call that was not cancelled must still hold, then return its own key when it is released.

Each wait has a guard, 30 seconds by default (`--guard`). The guard is a limit of the infrastructure, not a rule for the implementation. When a wait reaches it, the check fails with "did not settle". The guard never makes a check pass. After a check that holds calls, `acid-cat conform` releases each key that it used, and ends a command line that does not exit, so that the run always ends.

A test that a SHOULD rule fails gives a warning, not an error. Tests that need access to the code, for example of internal logs, are not part of conformance.
