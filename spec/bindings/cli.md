# CLI binding

A protocol binding that serves a view as a command line generated from the catalog, so a new capability gets its command with no change to the CLI. It depends on [Catalog](../catalog.md) and [Invocation](../invocation.md).

## Commands

- **Names.** Every capability in the view is a command whose path is the id's segments: `aircon.power.set` becomes `cli aircon power set`. A shared prefix is a command that only groups the commands beneath it.
- **Input.** Each top-level property of the input schema becomes a flag with the property's name, such as `--celsius 22` or `--celsius=22`. A property listed in `required` is a required flag. The flags only shape the input: the provider still validates the input it receives against the schema.

  | Property schema | Flag value |
  | --- | --- |
  | `enum` of strings | One of the strings |
  | `integer`, `number` | A number |
  | `boolean` | A switch |
  | `string` | The text as given |
  | Anything else | JSON text |

- **Generic commands.** `call <id> [input]` invokes any capability with the input as JSON text, `{}` by default. A capability whose input schema has no top-level `properties` is called this way. `list` prints the view's capabilities as JSON, each with its `id`, `description`, `available`, and a `usage` line.
- **Cancellation.** An interrupt (`SIGINT`) cancels the call.

An application MAY add commands and session flags of its own. A command path or flag name that is used twice is an error, which the CLI reports when it starts.

## Outcomes

Every answer is JSON. A result is printed on standard output. A call failure is printed on standard error as `{ "kind", "message" }`.

| Outcome | Standard output | Exit code |
| --- | --- | --- |
| Value | The value | 0 |
| Failure | The failure | 1 |
| `unknown-capability`, or an unknown command | nothing | 2 |
| `invalid-input`, including flags that do not parse | nothing | 3 |
| `unavailable` | nothing | 4 |
| `internal` | nothing | 5 |
| `cancelled` | nothing | 130 |

## Rationale

*This section is not normative.*

This is heb-stack's command line: a command generated for every id and a flag for every input property, with `list` and `call` alongside. Separate exit codes let a script, or an agent driving a shell, tell "the capability said no" from "the call never ran" without parsing any text.
