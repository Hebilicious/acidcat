# Models

This Moon project holds the formal models of the rules that each core follows. The models are written in [Quint](https://quint-lang.org). A model is the single source of a rule:

- `quint test` runs the examples of the model.
- `quint verify` proves the properties of the model with the Apalache model checker, for every input of small finite domains.
- A generator writes, from the model, the data of the rule for each core, and every case of a bounded domain with its expected result. Each core runs every case against its own functions, and must give the same result.

`quint test` and the generator use the TypeScript backend of Quint (`--backend=typescript`). The default Rust backend downloads an evaluator from the GitHub API when it first runs, and that API limits requests that are not authenticated.

The project is also the single source of the shared facts of the cores: names, numbers and the templates of messages that every core uses. See [Shared facts](#shared-facts).

The project is not a package. No registry receives it. It is in `model/` at the root of the repository, and not in `packages/`, because it is the source of files in several packages.

## What the models cover

[`cli-output.qnt`](cli-output.qnt) models the output flags and the automatic form of the CLI binding ([spec/bindings/cli.md](../spec/bindings/cli.md)):

- The automatic form: human when standard output is a terminal, `CI` is not truthy, and no variable of a coding agent is truthy. A variable is truthy when it is set to a value that is not `""`, `0`, `false`, `no` or `off`, after trimming and in any case. Trimming removes only the characters of `TRIM_CHARACTERS`: space, U+0009, U+000A, U+000B, U+000C and U+000D. The case changes only for the ASCII letters `A` to `Z`.
- The check of the output flags when the command line starts, with its messages: a flag with no name, a name that is not valid, a name of another output flag, a name of another flag of the command line, and a flag with no values.
- The first argument `--`: the program ignores it, before it reads the other arguments.
- The reading of the output flags in the arguments: until the first `--` that is not the first argument, and until an application command that is the first remaining argument; `--name value`, `--name=value` and `-x value`; `-x=value` is not an output flag; the last flag wins; a missing or unknown value stops the command line with exit code 3.
- The choice of the form: an output flag, else the default `json`, else the automatic form for the default `auto`.
- The messages, the line of the help of each output flag, and the lists in them. A list joins its last two items with a word and the others with `, `: `a, b or c`. The message of a bad value and the help give the values in code point order.

The model does not cover the human layout, the formatters, or the input and output of the process. The tests of each core cover them.

[`cli-aliases.qnt`](cli-aliases.qnt) models the check of the aliases of a target ([Aliases](../spec/bindings/cli.md#aliases)). Its input is abstract: the capabilities and the events, each with its id, whether it is in the view of the target, and an input schema with properties, with no properties or no input schema; whether the target has the binding `cli`; `options.cli`, with its aliases and its default alias. Each alias has a name and a value: not an object, or an object with `capability`, `event`, a fixed input and other members. The output is the list of errors, the accepted aliases and the default alias:

- `options.cli` that is not an object, a target with no binding `cli`, and `options.cli.aliases` that is not an object.
- The checks of each alias, in code point order of the names, and the first problem of each alias only: a name that is not one word, two words with one space between them, or `--` and one word; a name, or the first word of a two-word name, that is a command or a flag of the command line (`CLI_GENERIC_COMMANDS`, `PROGRAM_FLAGS`); a name, or the first word of a two-word name, that is the first word of the id of a capability in the view; a value that does not give exactly one id; a member that is not `capability`, `event`, `input` or a member that starts with `x-`; an id that is not in the view; a fixed input that is not an object; a fixed input for an input schema with no properties; and a key of the fixed input that is not a property.
- The default alias: it must be the name of a command alias. The checks of its flags apply only when the alias is accepted: a flag with the name of a flag of the program, and a flag alias with the name of a flag of the default alias. The flags of an alias of an event include the flags of `watch` (`RESUME_FLAGS`).

Each problem has the key of its template in `ALIAS_MESSAGES` and the parts that fill it. The generator fills the templates. The model does not cover the names of the commands and the flags that the application adds. The start of each core checks them with the commands of the application and the output flags.

Quint has no operations on strings. A text that a rule reads character by character is a list of characters, for example `["-", "-", "j", "s", "o", "n"]`. A text that the rules only write, such as a message, is a list of pieces. Quint strings have no escapes, so the model writes a control character or a Unicode space in angle brackets, for example `<TAB>`. The generator writes the real character. The template of a message is the message with a placeholder for each part, for example `The option {name} must be {values}.`

## Shared facts

[`facts.qnt`](facts.qnt) holds the plain facts that every core shares. No rule reads most of them, so they need no proofs. `cli-output.qnt` imports the module, and reads the flags of the program, the flags of `watch` and the exit codes from it. The generator writes the facts into `@acid-cat/spec-ts` and into each core that does not import spec-ts. `@acid-cat/core-ts` and `@acid-cat/core-effect` import the facts from spec-ts.

| Fact | Quint name | spec-ts (`packages/spec-ts/src/facts.generated.ts`) | acid-cat-core (`packages/core-rust/src/facts_generated.rs`) |
| --- | --- | --- | --- |
| The kinds of call failure, in order of precedence | `CALL_FAILURE_KINDS` | `CALL_FAILURE_KINDS` | `Kind::as_str` |
| The exit codes of the outcomes | `CLI_EXIT_CODES` | `CLI_EXIT_CODES` | `cli::exit` |
| The exit codes of the ends of a subscription | `CLI_WATCH_EXIT_CODES` | `CLI_WATCH_EXIT_CODES` | `cli::exit` |
| The HTTP status of each kind of call failure | `HTTP_STATUS` | `HTTP_STATUS` | `Kind::http_status` |
| The commands of the command line | `CLI_GENERIC_COMMANDS` | `CLI_GENERIC_COMMANDS` | `GENERIC_COMMANDS` |
| The flags of the program | `PROGRAM_FLAGS` | `CLI_RESERVED_FLAGS` | `PROGRAM_FLAGS` in `cli/output_generated.rs` |
| The flags of `watch` | `RESUME_FLAGS` | `CLI_RESUME_FLAGS`, without `--` | `RESUME_FLAGS` in `cli/output_generated.rs` |
| The time after which a stream sends a keepalive | `KEEPALIVE_MS` | `KEEPALIVE_MS` | `KEEPALIVE_MS`, read by `remote::KEEPALIVE` |
| The time after an interrupt at which the main program of the command line exits with code 130 | `INTERRUPT_GRACE_MS` | `INTERRUPT_GRACE_MS` | `INTERRUPT_GRACE_MS`, read by `cli::INTERRUPT_GRACE` |
| The media type of server-sent events | `SSE_MEDIA_TYPE` | `SSE_MEDIA_TYPE` | `SSE_MEDIA_TYPE` |
| The revision of MCP | `MCP_PROTOCOL_VERSION` | `MCP_PROTOCOL_VERSION` | `MCP_PROTOCOL_VERSION`, read by `mcp::PROTOCOL_VERSION` |
| The name of the MCP events extension | `MCP_EVENTS_EXTENSION` | `MCP_EVENTS_EXTENSION` | `MCP_EVENTS_EXTENSION` |
| The key of the subscription id in `_meta` | `MCP_SUBSCRIPTION_ID` | `MCP_SUBSCRIPTION_ID` | `MCP_SUBSCRIPTION_ID` |
| The JSON-RPC error of an unknown tool | `MCP_UNKNOWN_TOOL` | `MCP_UNKNOWN_TOOL` | `MCP_UNKNOWN_TOOL` |
| The JSON-RPC errors of the MCP events extension | `MCP_EVENT_ERRORS` | `MCP_EVENT_ERRORS` | `event_errors` |
| The HTTP status and the JSON-RPC error of each rejection of a request | `MCP_REJECTIONS` | `MCP_REJECTIONS` | `Rejection::status`, `Rejection::rpc_code` |
| The messages of the aliases of a target | `ALIAS_MESSAGES` | `ALIAS_MESSAGES`, which `cliAliases` fills | one `*_MESSAGE` constant for each message |
| The messages of a view that the command line cannot serve | `START_MESSAGES` | — | one `*_MESSAGE` constant for each message in `cli/output_generated.rs` |

The messages of a view that the command line cannot serve are in `MESSAGES` of `packages/core-ts/src/cli-output.generated.ts` and of `packages/core-effect/src/internal/output.generated.ts`, beside the messages of the output flags.

A message is a template with a named placeholder for each part, for example `The command {command} has the same name as a command of the command line.` Each core has one function that fills a template. A Rust match on `Kind` or `Rejection` in the generated file fails to compile when the enum and the model have different variants.

## Properties

[`cli-output-properties.qnt`](cli-output-properties.qnt) has two state machines, and [`cli-alias-properties.qnt`](cli-alias-properties.qnt) has one. Each one chooses its inputs with `nondet` from small finite domains in `init`. `quint verify --max-steps=0` then proves each invariant for every choice.

The properties of the arguments are about `readOutputFlags`: the reading of the arguments after the program ignores a first `--`. `outputChoice` is `programArguments`, then `readOutputFlags`.

| Property | Invariant | Module |
| --- | --- | --- |
| P1. Off a terminal, with no output flag before the stop, the form is JSON for each default, and the arguments stay unchanged and in order. The arguments after `--`, or after an application command that is the first remaining argument, can be output flags. | `notTerminalGivesJson` | `cliOutputArguments` |
| P2. An accepted configuration has names that are unique, well formed, not `--`, with no `=`, and not the names of other flags. | `acceptedNamesAreSafe` | `cliOutputNames` |
| P3. The arguments from `--`, or from an application command that is the first remaining argument, stay unchanged and in order. An application command in another place does not stop the reading. | `argumentsAfterTheStopStay` | `cliOutputArguments` |
| P4. When the arguments have output flags with valid values, the form is the form of the last one. | `lastOutputFlagWins` | `cliOutputArguments` |
| P5. A value flag with no value, or with an unknown value, stops the command line with exit code 3, and gives no form. | `badValueStops` | `cliOutputArguments` |
| P6. An accepted alias has no space at its start or its end, and one space at most; a flag alias has no space. Its first word is not a command or a flag of the command line, and not the first word of the path of a capability. Thus the first one or two arguments tell which alias runs, and an alias takes the place of no other command. | `acceptedAliasNamesAreSafe` | `cliAliasNames` |

The bounds are `MOST_SEGMENTS`, `MOST_AFTER` and `MOST_NAMES` in the module, and the domains beside them. Larger bounds prove more cases, and take more time.

- `cliOutputNames`: up to 2 output flags, each with up to 2 names from 9 names (valid, not valid and taken), and 4 kinds of flags.
- `cliAliasNames`: one alias of a capability, with one of 13 names: one word, two words, a flag alias, names with a bad space, and names whose first word is taken.
- `cliOutputArguments`: up to 2 output flags, each with up to 2 names from 4 valid names, and 4 kinds of flags; up to 3 segments of arguments (a plain word, the name of an application command, or a use of an output flag in each style); a stop (`--` or an application command); up to 1 argument after the stop; a value flag with no value or an unknown value; and an environment with `CI` and one variable of a coding agent.

## Cases

[`cli-output-cases.qnt`](cli-output-cases.qnt) makes every case of a bounded domain, with the result of the model:

- The automatic form: each terminal state, with each environment of one variable (`CI` or a variable of a coding agent) and each of 19 values. The values include each character of `TRIM_CHARACTERS`, and U+0085 and U+FEFF, which the trim keeps.
- The check: each output flag with up to 2 names from 16 names and 3 kinds, and each pair of flags with one name each.
- The reading: each list of up to 2 arguments from 20 arguments, and each list of 3 arguments from 8 arguments, with and without an application command. The arguments include each form that the reading takes: `--format text`, `--format=json`, `--format=`, `-f text`, `-f=text`, `--json`, `--json=`, `-H`, `--human`, and a flag with the values `high`, `1` and `2`.
- The choice of the form: each default, terminal state, 4 environments and 6 lists of arguments, with the form or the exit code and the message.
- The help: the line of 7 output flags, with values in an order that is not the code point order.

[`cli-alias-cases.qnt`](cli-alias-cases.qnt) makes every case of a bounded domain of the aliases, with 4 capabilities and 3 events in a fixed catalog:

- The target: each kind of `options.cli`, with and without the binding `cli`.
- One alias: each of 20 names, with names of two words, each of 24 values and 4 default aliases (none, not text, the alias, and a name that is not an alias).
- Two aliases: each pair of 6 names in reverse order, with a one-word alias and a two-word alias that starts with that word, each pair of 6 values, with the second name as the default alias.

## Tasks

| Task | What it does |
| --- | --- |
| `moon run model:test` | Run the examples of the models, and type-check the other modules. |
| `moon run model:prove` | Prove each property with `quint verify`. `moon run model:prove -- lastOutputFlagWins` proves only the properties that it names. `moon run verify` does not run it: the workflow `prove.yml` proves each property in its own job when a pull request changes `model/`, `.prototools` or `pnpm-lock.yaml`. The proofs read only the model, so a change to the code of a core does not change their result; the tests of the cases check the code of each core. It runs one Apalache server for each 7 GB of memory, up to one for each property, and proves the properties in parallel. On a computer with 30 GB of memory and 22 cores, it takes about 7 minutes. The longest proof takes about 5.5 minutes, and its Java and Z3 processes use up to about 1.8 GB. |
| `moon run model:generate` | Write the data and the cases into each core. |
| `moon run model:check` | Run `test`, then fail if a file in spec-ts or in a core is not the output of the model. `moon run verify` runs it. |

Apalache runs on Java. proto installs Java from [`.prototools`](../.prototools). `quint verify` downloads Apalache into `~/.quint` the first time that it runs.

## Generated files

`moon run model:generate` writes, for each core:

- The shared facts of [`facts.qnt`](#shared-facts), into spec-ts and the Rust core.
- The data: the variables of CI and of the coding agents, the false values, the characters that the trim removes, the flags of the program (`--help`, `--version`), the flags of `watch`, the reserved flags with their descriptions, the exit code of a bad value, the template of each message (the messages of the output flags, and the messages of a view that the command line cannot serve) and of each line of the help, the names of the forms, and the words and separators of the lists.
- The cases: the automatic form, the check, the reading, the choice of the form and the help, each with its expected result.
- The cases of the aliases, into spec-ts and the Rust core, each with its errors, its accepted aliases and its default alias.

The generator fails on a value of the model that it does not know, for example a new variant.

## Change a rule or a fact

To change a shared fact, change [`facts.qnt`](facts.qnt), run `moon run model:generate`, and change the code of each core that the new value breaks.

To change a rule:

1. Change the model. Add an example to its `run` tests, and a property when the rule is a guarantee that clients rely on.
2. Run `moon run model:test` and `moon run model:prove`.
3. Run `moon run model:generate`. It writes these files:

   | Core | Data | Cases |
   | --- | --- | --- |
   | `@acid-cat/core-ts` | `packages/core-ts/src/cli-output.generated.ts` | `packages/core-ts/test/fixtures/cli-output-cases.json` |
   | `@acid-cat/core-effect` | `packages/core-effect/src/internal/output.generated.ts` | `packages/core-effect/test/fixtures/cli-output-cases.json` |
   | `acid-cat-core` | `packages/core-rust/src/cli/output_generated.rs` | `packages/core-rust/tests/fixtures/cli_output_cases.json` |

   It also writes the shared facts into `packages/spec-ts/src/facts.generated.ts` and `packages/core-rust/src/facts_generated.rs`, and the cases of the aliases into `packages/spec-ts/test/fixtures/cli-alias-cases.json` and `packages/core-rust/tests/fixtures/cli_alias_cases.json`. `packages/spec-ts/test/alias-cases.test.ts` runs them against `cliAliases`, which `@acid-cat/core-ts`, `@acid-cat/core-effect` and `acid-cat check` use. `packages/core-rust/src/cli/alias_cases.rs` runs them against `cli_aliases`. It is a unit test, because `cli_aliases` is private. Cargo compiles it only for the tests, so the package builds without the cases file.

4. When the model has a new value in the data or a new kind of case, change the emitters and the readers of [`scripts/generate.ts`](scripts/generate.ts), and the test of the cases in each core.
5. Change the functions of each core until its test of the cases passes. Do not change a generated file by hand. `moon run model:check` fails when a generated file is not the output of the model.

## Add a core

1. Add an emitter for the language of the core to [`scripts/generate.ts`](scripts/generate.ts): the shared facts of [`facts.qnt`](facts.qnt), unless the core imports them from a package that has them, and the data, in the style of the language, with a first line that tells that the file is generated, and by which command. Add the paths of the data and of a copy of the cases to the list of outputs, and to the inputs of the task `check`. Add the copy of the cases to the inputs of the task `test` of the core.
2. Use the generated facts and data in the core, in place of its own constants and texts: fill the templates of the messages and of the help, trim only `TRIM_CHARACTERS`, change the case of ASCII letters only, and sort the values by code point.
3. Add one test that reads the cases file and runs each case against the pure functions of the core: the automatic form, the check of the output flags, the reading of the arguments, the choice of the form, and the help. The test compares each result exactly, messages and exit codes included. Put the test where the package of the core does not need the cases file, for example in the integration tests of a Rust crate.
