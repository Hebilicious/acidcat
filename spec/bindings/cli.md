# CLI binding

A protocol binding that serves a view as a command line. The commands come from the catalog. Thus a new capability or a new event gets its command with no change to the binding.

## Commands

- **Names.** Each capability in the view is a command. The segments of the id give the path of the command: `aircon.power.set` becomes `aircon power set`. A shared prefix is a command that only contains other commands.
- **Input.** Each top-level property of the input schema becomes a flag with the same name, for example `--celsius 22` or `--celsius=22`. Give a value that starts with `-` in the form `--name=value`, for example `--key=--cursor`. If the input schema has a `$ref`, use the type that it refers to, also when the schema has other members, such as a `description`. If a property schema is a `$ref`, use the type that it refers to. A property in `required` is a required flag. The provider validates the input against the schema.

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

- **First `--`.** A program MUST ignore a first argument `--`: `aircon -- status` is `aircon status`. Package runners, such as `pnpm` and `npx`, pass this `--` to the program. A `--` after the first argument is an argument.
- **Generic commands.** `call <id> [input]` calls a capability with its input as JSON text. The default input is `{}`. Use `call` when the input schema has no top-level `properties` member. `list` writes a JSON array: one item for each capability of the view, then one item for each event of the view. A capability has `kind: "capability"`, `id`, `description`, `available` and `usage`. A capability with one or more [aliases](#aliases) also has `aliases`: the usage of each alias, in code point order of the names of the aliases. An event has `kind: "event"`, `id`, `description` and `usage`, and `aliases` in the same way.
- **Usage.** The `usage` of a capability is one line of text that tells how to call it. Each part has one space before it:

  1. The name of the program.
  2. If the capability has an input schema with no top-level `properties` member: `call <id> '<json>'`, with the id of the capability. Nothing comes after it.
  3. If not, the path of the command, then one part for each flag. The required flags come first, then the optional flags. In each of these two lists, the flags are in code point order of their names.

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
- **Help.** If an argument after the path of a command is `--help`, the program MUST write the help of the capability to standard output, and the exit code is 0. The program does not call the capability. The **help** of a capability, an alias or an event has three parts, each on its own line:

  1. `Usage: ` and the usage.
  2. An empty line.
  3. The description.

  For example: `aircon power set --help` writes `Usage: aircon power set --on`, an empty line, and `Turn the unit on or off.`
- **Shared prefix.** The **command list** of a shared prefix has the line `Commands:`, then one line for each capability whose path starts with the words of the shared prefix. Each of these lines is two spaces and the usage of the capability. The capabilities are in the order of `list`. For example, `aircon status` has the command list `Commands:`, `  aircon status get` and `  aircon status export --path <string>`.

  | Arguments | Standard output | Standard error | Exit code |
  | --- | --- | --- | --- |
  | `<prefix> --help` | The command list | Nothing | 0 |
  | `<prefix>`, or `<prefix>` and arguments that are not `--help` | Nothing | The command list | 2 |

  A shared prefix can have one word or more words: `aircon --help` and `aircon status --help` are both the help of a shared prefix, if no capability has the path `aircon` or `aircon status`. The program uses the longest shared prefix at the start of the arguments. If the arguments after it do not continue the path of a command, the command is unknown. If one of these arguments is `--help`, the program writes the command list to standard output. If not, the program writes the command list to standard error. For example, `aircon power --on`, `aircon power nope` and `aircon power` all write the command list of `aircon power` to standard error, with exit code 2.
- **Cancellation.** An interrupt (`SIGINT`) cancels the call. If the call has not ended within a grace period after the interrupt, the program SHOULD exit with code 130. At a second interrupt, it SHOULD exit with code 130 at once.

An application MAY add its own commands and flags. The name of a command of the application is one word. This name MUST NOT be `call`, `list`, `watch`, the name of a different command of the application, the first word of the name of a command alias, or the first word of the path of a capability. If a name breaks this rule, if two commands have the same path, or if two flags have the same name, the program MUST stop with an error when it starts.

## Aliases

An **alias** is a short name for a capability or an event. The catalog gives the aliases of a target in the options of the target, in `options.cli.aliases`. Each key is the name of an alias. Each value is an object with one of `capability` and `event`:

| Member | Required | Value |
| --- | --- | --- |
| `capability` | One of the two | The id of the capability. The capability MUST be in the view of the target |
| `event` | One of the two | The id of the event. The event MUST be in the view of the target |
| `input` | No | A JSON object: the **fixed input**. Each key MUST be a top-level property of the input schema of the capability or the event |

An alias can also have members whose names start with `x-`. A program ignores them. An alias MUST NOT have other members.

`options.cli.default` is the name of the **default alias**. It MUST be the name of a command alias.

```json
{
  "targets": {
    "cli": {
      "bindings": ["cli"],
      "options": {
        "cli": {
          "aliases": {
            "status": { "capability": "aircon.status.get" },
            "--on": { "capability": "aircon.power.set", "input": { "on": true } },
            "--off": { "capability": "aircon.power.set", "input": { "on": false } },
            "follow": { "event": "aircon.status.changed" },
            "fan": { "capability": "aircon.fan.set" },
            "fan high": { "capability": "aircon.fan.set", "input": { "speed": "high" } }
          },
          "default": "status"
        }
      }
    }
  }
}
```

- **Target.** A target that has `options.cli` MUST have the binding `cli`.
- **Names.** A **command alias** has a name that is one word, or two words with one space between them, for example `fan high`. A **flag alias** has a name that is `--` and one word. Each word matches `[a-z][a-z0-9]*(-[a-z0-9]+)*`. The first word of the name of a command alias MUST NOT be `call`, `list`, `watch`, the name of a command of the application, or the first word of the path of a capability. The name of a flag alias MUST NOT be `--help`, `--version`, or the name of a different flag of the program, for example a flag that the application adds.
- **Group.** The command aliases whose names have the same first word are a **group**. A group can have a one-word alias with that word and two-word aliases: `fan`, `fan auto` and `fan high`.
- **Call.** The name of an alias is the first argument, or the first two arguments for a two-word alias: `aircon status`, `aircon --on`, `aircon fan high`. The flags come after the name, with the rules of [Commands](#commands). The flags come from the properties of the input schema that are not in the fixed input. A property in the fixed input is not a flag: a flag with its name is not valid. The input is the fixed input with the properties of the flags. The provider validates this input, fixed input included, as it validates the input of each call or subscription. If an argument after the name is `--help`, the program MUST write the [help](#commands) of the alias to standard output, with the usage of the alias, and the exit code is 0.
- **Call of a group.** If the first two arguments are the name of a two-word alias, the program runs that alias. This is also true when the one-word alias of the group takes the input as JSON text. If not, and the first argument is the name of a one-word alias, the program runs the one-word alias with the other arguments. But if the group of that alias has two-word aliases, and the second argument is a word, the arguments are an unknown command: `aircon fan medium`. A word is a text that matches the pattern of a word in **Names**. If the first argument is the first word of a group with no one-word alias, and the first two arguments are not the name of an alias, the arguments are an unknown command.
- **Capability.** An alias of a capability makes the same call as the command of the capability, with the outcomes of [Outcomes](#outcomes).
- **Event.** An alias of an event subscribes as `watch` does, with the same ends and exit codes: `aircon follow` is `aircon watch aircon.status.changed`. It also takes `--cursor` and `--max-age-ms`, as in [Events](#events).
- **No input.** If the capability or the event has no input schema, the alias has no flags from the input, and takes no other argument.
- **No properties.** If the capability or the event has an input schema with no top-level `properties` member, the alias takes the input as JSON text, as `call` and `watch` do: `<name> [input]`. The default input is `{}`. Such an alias MUST NOT have a fixed input.
- **Usage.** The usage of an alias is the name of the program, the name of the alias with each of its words, then the flags as in [Commands](#commands), with only the properties that are not in the fixed input. If the input schema has no top-level `properties` member, the flags are replaced by `'<json>'`. The usage of an alias of an event ends with `[--cursor <string>] [--max-age-ms <integer>]`. For example: `aircon status`, `aircon --on`, `aircon fan high` and `aircon follow [--cursor <string>] [--max-age-ms <integer>]`.
- **Default alias.** With no arguments, the program runs the default alias: `aircon` is `aircon status`. The default alias can have one word or two words. If the first argument starts with `--`, and it is not the name of a flag alias or a flag of the program, the program runs the default alias with all the arguments as its flags. A flag of the default alias MUST NOT have the name of a flag alias or of a different flag of the program. `--help` writes the help. With no default alias, the program writes the help when it gets no arguments.

If an alias breaks a rule of this section, the program MUST stop with an error when it starts. `acid-cat check` rejects a catalog with an alias that breaks a rule of this section.

## Events

- **Names.** `watch <id>` subscribes to the event with that id.
- **Input.** If the input schema of the event has a top-level `properties` member, each property is a flag, with the rules of [Commands](#commands): `aircon watch aircon.status.changed --room kitchen`. If not, `watch <id> [input]` takes the input as JSON text. The default input is `{}`.
- **Cursor.** `--cursor <cursor>` gives the cursor, and `--max-age-ms <integer>` gives `maxAgeMs`. Each occurrence on standard output has its cursor, so a script can keep the last cursor, and resume with it after the program stops. These two flags are not properties of the input. If the input schema of an event has a top-level property `cursor` or `max-age-ms`, the program MUST stop with an error when it starts.
- **Usage.** The `usage` of an event is the name of the program, `watch`, the id, the flags as for a capability, and then `[--cursor <string>] [--max-age-ms <integer>]`. If the input schema has no top-level `properties` member, it is the name of the program, `watch <id> '<json>'`, and the same two flags.
- **Help.** If an argument after `watch <id>` is `--help`, and the event is in the view, the program MUST write the [help](#commands) of the event to standard output, with the usage of the event, and the exit code is 0. The program does not subscribe.
- **Occurrences.** Each occurrence goes to standard output as its JSON on one line, as soon as it comes.
- **Cancellation.** An interrupt (`SIGINT`) cancels the subscription. If the subscription has not ended within a grace period after the interrupt, the program SHOULD exit with code 130, and write nothing to standard error. At a second interrupt, it SHOULD exit in the same way at once.

| End | Standard error | Exit code |
| --- | --- | --- |
| Complete | Nothing | 0 |
| Cancelled | Nothing | 130 |
| `internal` | `{ "kind", "message" }` | 5 |

A call failure before the first occurrence has the exit code of the table in [Outcomes](#outcomes), and goes to standard error. An interrupt is always the end Cancelled, also before the first occurrence and before the subscription starts: nothing goes to standard error.

## Outcomes

The output is JSON. A result goes to standard output. A call failure goes to standard error as `{ "kind", "message" }`.

A core MAY also write a form of the output for a person. That form, and the way to choose it, are a concern of the core. The flags that choose the form are flags that the application adds. When standard output is not a terminal, the output MUST be JSON, unless the user asks for another form. The exit code and the stream of each outcome are the same in each form.

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

A default alias gives a program one main operation, such as `build`, with no command word.

A group gives a short path to a few related operations, such as `inbox adopt` and `inbox reject`, with no namespace word before them. Its one-word alias, such as `inbox`, is the main operation of the group. A command alias has two words at most, so the first two arguments always tell which alias runs. A second argument that is one word, and that is not the second word of an alias of the group, is an unknown command and not the input of the one-word alias. Thus a mistyped name, such as `inbox adpot`, stops with exit code 2. It does not run the one-word alias.

An alias is in the catalog, and not only in the code of the program. Thus `acid-cat check` tests it, `list` gives it to agents, and each core serves the same aliases. A flag alias, such as `--on`, gives a command line the form of a switch, which the commands of the capabilities cannot have, because each id has two or more segments.

A repeated flag is easier to type than JSON text, and it needs fewer quotes in a shell. A repeated flag also takes JSON text of the whole array. Thus a script can give JSON text to each array flag, with simple items or not.

The two forms have one conflict. A flag that occurs once with the value `["a"]` gives the array `["a"]`, not an array with the one string `["a"]`. To give an array of strings whose only item is JSON text of an array, use `call`, or give the item as JSON text: `--tags '["[\"a\"]"]'`.
