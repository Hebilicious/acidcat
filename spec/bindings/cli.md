# CLI binding

A protocol binding that serves a view as a command line. The commands come from the catalog. Thus a new capability gets its command with no change to the binding.

## Commands

- **Names.** Each capability in the view is a command. The segments of the id give the path of the command: `aircon.power.set` becomes `aircon power set`. A shared prefix is a command that only contains other commands.
- **Input.** Each top-level property of the input schema becomes a flag with the same name, for example `--celsius 22` or `--celsius=22`. If the input schema is a `$ref`, use the type that it refers to. A property in `required` is a required flag. The provider validates the input against the schema.

  | Property schema | Flag value |
  | --- | --- |
  | `enum` of strings | One of the strings |
  | `integer` or `number` | A number |
  | `boolean` | A switch |
  | `string` | The text |
  | Other | JSON text |

- **Generic commands.** `call <id> [input]` calls a capability with its input as JSON text. The default input is `{}`. Use `call` when the input schema has no top-level `properties`. `list` writes the capabilities of the view as JSON: `id`, `description`, `available` and `usage`.
- **Usage.** The `usage` of a capability is one line of text that tells how to call it. Each part has one space before it:

  1. The name of the program.
  2. If the capability has an input schema with no top-level `properties`: `call <id> '<json>'`, with the id of the capability. Nothing comes after it.
  3. If not, the path of the command, then one part for each flag. The required flags come first. In each group, the flags are in code point order of their names.

  | Property schema | Required flag | Optional flag |
  | --- | --- | --- |
  | `enum` of strings | `--name <a\|b>`, with the strings in the order of the `enum` | `[--name <a\|b>]` |
  | `integer` | `--name <integer>` | `[--name <integer>]` |
  | `number` | `--name <number>` | `[--name <number>]` |
  | `boolean` | `--name` | `[--name]` |
  | `string` | `--name <string>` | `[--name <string>]` |
  | Other | `--name <json>` | `[--name <json>]` |

  If a property schema is a `$ref`, use the type that it refers to. A capability with no input schema has no flags. For example, with the program name `aircon`: `aircon power set --on`, `aircon fan set --speed <auto|low|medium|high>` and `aircon status get`.
- **Cancellation.** An interrupt (`SIGINT`) cancels the call.

An application MAY add its own commands and flags. If two commands have the same path, or two flags have the same name, the program MUST stop with an error when it starts.

## Outcomes

All output is JSON. A result goes to standard output. A call failure goes to standard error as `{ "kind", "message" }`.

| Outcome | Standard output | Exit code |
| --- | --- | --- |
| Value | The value | 0 |
| Failure | The failure | 1 |
| `unknown-capability`, or an unknown command | Nothing | 2 |
| `invalid-input`, or a flag that is not valid | Nothing | 3 |
| `unavailable` | Nothing | 4 |
| `internal` | Nothing | 5 |
| `cancelled` | Nothing | 130 |

## Design notes

*This section is not normative.*

Different exit codes let a script or an agent know if "the capability said no" or "the call did not run", without reading text.
