# CLI binding

This binding serves the `cli` target as a command line. Commands are generated from the catalog, so a new capability whose audience names `cli` gets its command with no change to the binding. It depends on [Targets](../targets.md), [Identifiers](../identifiers.md), [Manifest](../manifest.md) and [Invocation](../invocation.md).

## Commands

Every capability the session serves is a command. Its path is the id's segments, so `primes.history.list` becomes `cli primes history list`. Each namespace, and each shared prefix below it, is a command that only groups the commands beneath it.

The binding also has two commands of its own:

- `list` prints a JSON array of the capabilities the session serves. Each entry has its `id`, its `description`, and a `usage` line that shows how to call it.
- `call <id> [input]` invokes a capability by id, with the input as JSON text. The input defaults to `{}`.

An application MAY add commands of its own. A command path that the binding or the application uses twice is an error, which the binding reports when it starts.

## Flags

Each property at the top level of a capability's `inputSchema` becomes a flag with the property's name, as in `--n 97` or `--n=97`. The flag reads its value according to the property's schema:

| Property | Flag value |
| --- | --- |
| `enum` of strings | One of the listed strings |
| `integer`, `number` | A number |
| `boolean` | A switch |
| `string` | The text as given |
| Anything else | JSON text |

A property listed in `required` is a required flag. The flags only shape the input: the capability still decodes the input it receives with its own schema.

A capability whose input schema has no top-level `properties`, such as a union of shapes, is invoked through `call`.

The binding MAY have flags of its own that configure the session, such as a storage location. A capability property with the same name as one of them is an error, which the binding reports when it starts.

## Outcomes

Every answer is JSON. A result goes to standard output, and an invocation failure goes to standard error as `{ "kind": <kind>, "message": <text> }`.

| Outcome | Standard output | Exit code |
| --- | --- | --- |
| Success | The value | 0 |
| Expected failure | The failure, with its `_tag` | 1 |
| `unknown-capability`, or an unknown command | nothing | 2 |
| `invalid-input`, including flags that do not parse | nothing | 3 |
| `unavailable` | nothing | 4 |
| `internal` | nothing | 5 |
| `cancelled` | nothing | 130 |

An interrupt (`SIGINT`) aborts the invocation's signal.

## Rationale

*This section is not normative.*

**HS's command line is adopted.** HS generates its commands from the catalog: a command for each id, and a flag for each input property. That gives people readable commands and gives agents a usage line for every capability, with no capability map to maintain. JB's `list` and `call` survive inside HS's design, because HS has them too.

**Exit codes keep the kinds apart.** JB exits 1 for every failure, and HS exits 1 for both expected failures and defects. A script, or an agent driving a shell, should be able to tell "the capability said no" from "the call never ran" without parsing text. Codes 0, 1 and 2 keep their current meanings in HS. Code 130 is the shell convention for an interrupt.

**Changes for each implementation.**
- JB: generate commands from ids, and keep its `solve` command as an application command.
- HS: give invocation failures their own exit codes and their `{ kind, message }` body.
