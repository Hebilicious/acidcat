# CLI binding

A protocol binding that serves a view as a command line. The commands come from the catalog. Thus a new capability or a new event gets its command with no change to the binding.

## Commands

- **Names.** Each capability in the view is a command. The segments of the id give the path of the command: `aircon.power.set` becomes `aircon power set`. A shared prefix is a command that only contains other commands.
- **Input.** Each top-level property of the input schema becomes a flag with the same name, for example `--celsius 22` or `--celsius=22`. If the input schema is a `$ref`, use the type that it refers to. If a property schema is a `$ref`, use the type that it refers to. A property in `required` is a required flag. The provider validates the input against the schema.

  | Property schema | Flag value |
  | --- | --- |
  | `enum` of strings | One of the strings |
  | `integer` or `number` | A number |
  | `boolean` | A switch |
  | `string` | The text |
  | `array` with simple items | One item, or JSON text of the array. The flag is a repeated flag |
  | Other | JSON text |

  The items of an `array` are simple if its `items` schema is an `enum` of strings, `integer`, `number` or `string`. If the `items` schema is a `$ref`, use the type that it refers to. A repeated flag gives the array in one of two forms:

  1. If the flag occurs exactly once, and its value is JSON text of an array, the array is that value. For example, `--seasons '[1,2]'` gives `[1, 2]`, and `--seasons '[]'` gives an empty array.
  2. If not, each occurrence of the flag gives one item, with the flag value of the `items` schema. The items are in the order of the flags. For example, `--seasons 1 --seasons 2` gives `[1, 2]`, and `--tags '["a"]' --tags b` gives the two strings `["a"]` and `b`.

  A required repeated flag MUST occur at least once. If an optional repeated flag does not occur, the input does not have the property. An `array` with other items, or with no `items` schema, takes JSON text.

- **Generic commands.** `call <id> [input]` calls a capability with its input as JSON text. The default input is `{}`. Use `call` when the input schema has no top-level `properties` member. `list` writes a JSON array: one item for each capability of the view, then one item for each event of the view. A capability has `kind: "capability"`, `id`, `description`, `available` and `usage`. An event has `kind: "event"`, `id`, `description` and `usage`.
- **Usage.** The `usage` of a capability is one line of text that tells how to call it. Each part has one space before it:

  1. The name of the program.
  2. If the capability has an input schema with no top-level `properties` member: `call <id> '<json>'`, with the id of the capability. Nothing comes after it.
  3. If not, the path of the command, then one part for each flag. The required flags come first. In each group, the flags are in code point order of their names.

  | Property schema | Required flag | Optional flag |
  | --- | --- | --- |
  | `enum` of strings | `--name <a\|b>`, with the strings in the order of the `enum` | `[--name <a\|b>]` |
  | `integer` | `--name <integer>` | `[--name <integer>]` |
  | `number` | `--name <number>` | `[--name <number>]` |
  | `boolean` | `--name` | `[--name]` |
  | `string` | `--name <string>` | `[--name <string>]` |
  | `array` with simple items | `--name <value>...`, with `<value>` as for the `items` schema, for example `--name <integer>...` or `--name <a\|b>...` | `[--name <value>...]` |
  | Other | `--name <json>` | `[--name <json>]` |

  If a property schema or an `items` schema is a `$ref`, use the type that it refers to. A capability with no input schema, or with `"properties": {}`, has no flags. For example, with the program name `aircon`: `aircon power set --on`, `aircon fan set --speed <auto|low|medium|high>`, `aircon schedule set --days <mon|tue|wed|thu|fri|sat|sun>... [--hours <integer>...]` and `aircon status get`.
- **Cancellation.** An interrupt (`SIGINT`) cancels the call.

An application MAY add its own commands and flags. The name of a command of the application is one word. This name MUST NOT be `call`, `list`, `watch`, the name of a different command of the application, or the first word of the path of a capability. If a name breaks this rule, if two commands have the same path, or if two flags have the same name, the program MUST stop with an error when it starts.

## Events

- **Names.** `watch <id>` subscribes to the event with that id.
- **Input.** If the input schema of the event has a top-level `properties` member, each property is a flag, with the rules of [Commands](#commands): `aircon watch aircon.status.changed --room kitchen`. If not, `watch <id> [input]` takes the input as JSON text. The default input is `{}`.
- **Cursor.** `--cursor <cursor>` gives the cursor, and `--max-age-ms <integer>` gives `maxAgeMs`. Each occurrence on standard output has its cursor, so a script can keep the last cursor, and resume with it after the program stops. These two flags are not properties of the input. If the input schema of an event has a top-level property `cursor` or `max-age-ms`, the program MUST stop with an error when it starts.
- **Usage.** The `usage` of an event is the name of the program, `watch`, the id, the flags as for a capability, and then `[--cursor <string>] [--max-age-ms <integer>]`. If the input schema has no top-level `properties` member, it is the name of the program, `watch <id> '<json>'`, and the same two flags.
- **Occurrences.** Each occurrence goes to standard output as its JSON on one line, as soon as it comes.
- **Cancellation.** An interrupt (`SIGINT`) cancels the subscription.

| End | Standard error | Exit code |
| --- | --- | --- |
| Complete | Nothing | 0 |
| Cancelled | Nothing | 130 |
| `internal` | `{ "kind", "message" }` | 5 |

A call failure before the first occurrence has the exit code of the table in [Outcomes](#outcomes), and goes to standard error.

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

## Server

The command line can serve a view of an application that runs in another process, for example on a server. It is then a client of the [HTTP binding](http.md) of that application, at a base URL that the deployment gives.

- The commands, the flags and the usage come from the view in the program, as in [Commands](#commands). The program does not read the catalog of the server at run time.
- A call is `POST {base}/capabilities/{id}`. `list` gets the availability of each capability from `GET {base}/capabilities`. A capability that the server does not list is unavailable.
- `watch` is `POST {base}/events/{id}`, with the cursor in `Last-Event-ID` and `maxAgeMs` in the query. Each `next` message is one occurrence on standard output. `complete` is the end with exit code 0, and `error` is the end with its call failure.
- The program writes the outcomes of the server as [Outcomes](#outcomes) tells. A call failure from the server has its kind.
- If the server does not answer, the call failure is `unavailable`. If the server gives an answer that the HTTP binding does not give, the call failure is `internal`.
- An interrupt (`SIGINT`) closes the request. The server then cancels the call or the subscription.
- The deployment MAY add headers to each request, for example a token in `Authorization`. The program MUST NOT write these headers to standard output or standard error.
- Serve the HTTP binding with the target of the command line, so that both have the same view.

## Design notes

*This section is not normative.*

Different exit codes let a script or an agent know if "the capability said no" or "the call did not run", without reading text.

One line of JSON for each occurrence lets a script read occurrences one at a time, for example with `jq`, while the subscription continues.

A repeated flag is easier to type than JSON text, and it needs fewer quotes in a shell. A repeated flag also takes JSON text of the whole array. Thus a script can give JSON text to each array flag, with simple items or not.

The two forms have one conflict. A flag that occurs once with the value `["a"]` gives the array `["a"]`, not an array with the one string `["a"]`. To give an array of strings whose only item is JSON text of an array, use `call`, or give the item as JSON text: `--tags '["[\"a\"]"]'`.
