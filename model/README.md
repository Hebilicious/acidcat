# Models

This Moon project holds formal models, written in [Quint](https://quint-lang.org), of the rules that every core must follow the same way. It also holds the facts the cores share: names, numbers and message templates.

## Why the models exist

AcidCat has several cores, and each one must parse the same arguments, accept the same aliases, and print the same messages. Hand-written copies of a rule drift apart. So each shared rule has one source, the model, and every core is tested against it:

- `quint test` runs the model's examples.
- `quint verify` uses the Apalache model checker to prove the model's properties for every input in small finite domains.
- A generator reads the model and writes, for each core, the rule's data and every case of a bounded domain with its expected result. Each core runs every case against its own functions and must give the same result.

`quint test` and the generator use Quint's TypeScript backend (`--backend=typescript`). The default Rust backend downloads an evaluator from the GitHub API on first run, and that API rate-limits unauthenticated requests.

The project lives in `model/` at the repository root, not in `packages/`, because it is the source of files in several packages. It is not a package, and no registry receives it.

## Change a rule or a fact

Change the model first, generate, then fix each core. Never edit a generated file by hand: `moon run model:check` fails when a generated file differs from the model's output.

To change a shared fact, edit [`facts.qnt`](facts.qnt), run `moon run model:generate`, and fix the code in each core that the new value breaks.

To change a rule:

1. Change the model. Add an example to its `run` tests. Add a property when the rule is a guarantee that clients rely on.
2. Run `moon run model:test` and `moon run model:prove`.
3. Run `moon run model:generate`. It writes these files:

   | Core | Data | Cases |
   | --- | --- | --- |
   | `@acid-cat/core-ts` | `packages/core-ts/src/cli-output.generated.ts` | `packages/core-ts/test/fixtures/cli-output-cases.json` |
   | `@acid-cat/core-effect` | `packages/core-effect/src/internal/output.generated.ts` | `packages/core-effect/test/fixtures/cli-output-cases.json` |
   | `acid-cat-core` | `packages/core-rust/src/cli/output_generated.rs` | `packages/core-rust/tests/fixtures/cli_output_cases.json` |

   It also writes the shared facts to `packages/spec-ts/src/facts.generated.ts` and `packages/core-rust/src/facts_generated.rs`, and the alias cases to `packages/spec-ts/test/fixtures/cli-alias-cases.json` and `packages/core-rust/tests/fixtures/cli_alias_cases.json`.

4. If the model has a new value in the data or a new kind of case, update the emitters and readers in [`scripts/generate.ts`](scripts/generate.ts), and each core's case test.
5. Change each core's functions until its case test passes.

The case tests are:

- `packages/spec-ts/test/alias-cases.test.ts` runs the alias cases against `cliAliases`, which `@acid-cat/core-ts`, `@acid-cat/core-effect` and `acid-cat check` use.
- `packages/core-rust/src/cli/alias_cases.rs` runs them against `cli_aliases`. It is a unit test because `cli_aliases` is private. Cargo compiles it only for tests, so the crate builds without the cases file.
- Each core has one test that reads its `cli-output` cases file.

## Tasks

| Task | What it does |
| --- | --- |
| `moon run model:test` | Run the models' examples and type-check the other modules. |
| `moon run model:prove` | Prove each property with `quint verify`. `moon run model:prove -- lastOutputFlagWins` proves only the properties it names. |
| `moon run model:generate` | Write the data and the cases into each core. |
| `moon run model:check` | Run `test`, then fail if a file in spec-ts or in a core is not the model's output. `moon run verify` runs it. |

`moon run verify` does not run `model:prove`. Instead, the workflow `prove.yml` proves each property in its own job when a pull request changes `model/`, `.prototools` or `pnpm-lock.yaml`. The proofs read only the model, so a change to a core's code cannot change their result; the case tests check each core's code.

`model:prove` starts one Apalache server per 7 GB of memory, up to one per property, and proves the properties in parallel. On a computer with 30 GB of memory and 22 cores it takes about 7 minutes. The longest proof takes about 5.5 minutes, and its Java and Z3 processes use up to about 1.8 GB.

Apalache runs on Java, which proto installs from [`.prototools`](../.prototools). `quint verify` downloads Apalache into `~/.quint` the first time it runs.

## What the models cover

### Output flags and the automatic form

[`cli-output.qnt`](cli-output.qnt) models the output flags and the automatic form of the CLI binding ([spec/bindings/cli.md](../spec/bindings/cli.md)):

- The automatic form is human when standard output is a terminal, `CI` is not truthy, and no coding-agent variable is truthy. A variable is truthy when its value is not `""`, `0`, `false`, `no` or `off`, after trimming and ignoring case. Trimming removes only the characters in `TRIM_CHARACTERS`: space, U+0009, U+000A, U+000B, U+000C and U+000D. Case folding applies only to the ASCII letters `A` to `Z`.
- The check of the output flags at startup, with its messages: a flag with no name, an invalid name, a name of another output flag, a name of another command-line flag, and a flag with no values.
- A first argument `--` is ignored before the other arguments are read.
- Reading the output flags from the arguments. Reading stops at the first `--` that is not the first argument, and at an application command that is the first remaining argument. The forms are `--name value`, `--name=value` and `-x value`; `-x=value` is not an output flag. The last flag wins. A missing or unknown value stops the command line with exit code 3.
- Choosing the form: an output flag, else the default `json`, else the automatic form when the default is `auto`.
- The messages, each output flag's help line, and the lists inside them. A list joins its last two items with a word and the others with `, `, as in `a, b or c`. The bad-value message and the help list the values in code point order.

The model does not cover the human layout, the formatters, or the process's input and output. Each core's tests cover those.

### Aliases

[`cli-aliases.qnt`](cli-aliases.qnt) models the check of a target's [aliases](../spec/bindings/cli.md#aliases).

Its input is abstract:

- The capabilities and events. Each has an id, whether it is in the target's view, and an input schema with properties, an input schema with no properties, or no input schema.
- Whether the target has the `cli` binding.
- `options.cli`, with its aliases and default alias. Each alias has a name and a value. The value is either not an object, or an object with `capability`, `event`, a fixed input and other members.

Its output is the list of errors, the accepted aliases, and the default alias. The errors are:

- `options.cli` is not an object, the target has no `cli` binding, or `options.cli.aliases` is not an object.
- For each alias, in code point order of the names, only the first problem:
  - the name is not one word, two words separated by one space, or `--` and one word;
  - the name, or the first word of a two-word name, is a command or a flag of the command line (`CLI_GENERIC_COMMANDS`, `PROGRAM_FLAGS`);
  - the name is the command path of a capability in the view;
  - the value does not give exactly one id;
  - a member is not `capability`, `event`, `input`, or a member that starts with `x-`;
  - the id is not in the view;
  - the fixed input is not an object;
  - there is a fixed input for an input schema with no properties;
  - a key of the fixed input is not a property.
- The default alias must be the name of a command alias. Its flags are checked only when the alias is accepted: a flag with the name of a program flag, and a flag alias with the name of a flag of the default alias. The flags of an event alias include the flags of `watch` (`RESUME_FLAGS`).

Each problem has the key of its template in `ALIAS_MESSAGES` and the parts that fill it, and the generator fills the templates. The model does not cover the names of the commands and flags that the application adds. Each core checks those at startup, against the application's commands and the output flags.

### How the models represent text

Quint has no string operations. A text that a rule reads character by character is a list of characters, for example `["-", "-", "j", "s", "o", "n"]`. A text that the rules only write, such as a message, is a list of pieces.

Quint strings have no escapes, so the model writes a control character or a Unicode space in angle brackets, for example `<TAB>`. The generator writes the real character.

A message template is the message with a named placeholder for each part, for example `The option {name} must be {values}.` or `The command {command} has the same name as a command of the command line.` Each core has one function that fills a template.

## Shared facts

[`facts.qnt`](facts.qnt) holds plain facts that every core shares. No rule reads most of them, so they need no proofs. `cli-output.qnt` imports the module for the program flags, the flags of `watch`, and the exit codes.

The generator writes the facts into `@acid-cat/spec-ts` and into each core that does not import spec-ts. `@acid-cat/core-ts` and `@acid-cat/core-effect` import them from spec-ts.

| Fact | Quint name | spec-ts (`packages/spec-ts/src/facts.generated.ts`) | acid-cat-core (`packages/core-rust/src/facts_generated.rs`) |
| --- | --- | --- | --- |
| The kinds of call failure, in order of precedence | `CALL_FAILURE_KINDS` | `CALL_FAILURE_KINDS` | `Kind::as_str` |
| The exit code of each outcome | `CLI_EXIT_CODES` | `CLI_EXIT_CODES` | `cli::exit` |
| The exit code of each way a subscription ends | `CLI_WATCH_EXIT_CODES` | `CLI_WATCH_EXIT_CODES` | `cli::exit` |
| The HTTP status of each kind of call failure | `HTTP_STATUS` | `HTTP_STATUS` | `Kind::http_status` |
| The commands of the command line | `CLI_GENERIC_COMMANDS` | `CLI_GENERIC_COMMANDS` | `GENERIC_COMMANDS` |
| The program flags | `PROGRAM_FLAGS` | `CLI_RESERVED_FLAGS` | `PROGRAM_FLAGS` in `cli/output_generated.rs` |
| The flags of `watch` | `RESUME_FLAGS` | `CLI_RESUME_FLAGS`, without `--` | `RESUME_FLAGS` in `cli/output_generated.rs` |
| The time after which a stream sends a keepalive | `KEEPALIVE_MS` | `KEEPALIVE_MS` | `KEEPALIVE_MS`, read by `remote::KEEPALIVE` |
| The time after an interrupt when the command line's main program exits with code 130 | `INTERRUPT_GRACE_MS` | `INTERRUPT_GRACE_MS` | `INTERRUPT_GRACE_MS`, read by `cli::INTERRUPT_GRACE` |
| The media type of server-sent events | `SSE_MEDIA_TYPE` | `SSE_MEDIA_TYPE` | `SSE_MEDIA_TYPE` |
| The MCP revision | `MCP_PROTOCOL_VERSION` | `MCP_PROTOCOL_VERSION` | `MCP_PROTOCOL_VERSION`, read by `mcp::PROTOCOL_VERSION` |
| The name of the MCP events extension | `MCP_EVENTS_EXTENSION` | `MCP_EVENTS_EXTENSION` | `MCP_EVENTS_EXTENSION` |
| The key of the subscription id in `_meta` | `MCP_SUBSCRIPTION_ID` | `MCP_SUBSCRIPTION_ID` | `MCP_SUBSCRIPTION_ID` |
| The JSON-RPC error for an unknown tool | `MCP_UNKNOWN_TOOL` | `MCP_UNKNOWN_TOOL` | `MCP_UNKNOWN_TOOL` |
| The JSON-RPC errors of the MCP events extension | `MCP_EVENT_ERRORS` | `MCP_EVENT_ERRORS` | `event_errors` |
| The HTTP status and JSON-RPC error of each request rejection | `MCP_REJECTIONS` | `MCP_REJECTIONS` | `Rejection::status`, `Rejection::rpc_code` |
| The messages for a target's aliases | `ALIAS_MESSAGES` | `ALIAS_MESSAGES`, which `cliAliases` fills | one `*_MESSAGE` constant per message |
| The messages for a view that the command line cannot serve | `START_MESSAGES` | none | one `*_MESSAGE` constant per message in `cli/output_generated.rs` |

In the TypeScript cores, the messages for a view that the command line cannot serve are in `MESSAGES` in `packages/core-ts/src/cli-output.generated.ts` and `packages/core-effect/src/internal/output.generated.ts`, next to the output-flag messages.

In the generated Rust file, a `match` on `Kind` or `Rejection` fails to compile when the enum and the model have different variants.

## Properties

[`cli-output-properties.qnt`](cli-output-properties.qnt) has two state machines, and [`cli-alias-properties.qnt`](cli-alias-properties.qnt) has one. Each chooses its inputs with `nondet` from small finite domains in `init`, and `quint verify --max-steps=0` proves each invariant for every choice.

The argument properties are about `readOutputFlags`, which reads the arguments after the program ignores a first `--`. `outputChoice` is `programArguments` followed by `readOutputFlags`.

| Property | Invariant | Module |
| --- | --- | --- |
| P1. Off a terminal, with no output flag before the stop, the form is JSON for each default, and the arguments stay unchanged and in order. The arguments after `--`, or after an application command that is the first remaining argument, can be output flags. | `notTerminalGivesJson` | `cliOutputArguments` |
| P2. An accepted configuration has names that are unique, well formed, not `--`, free of `=`, and not the names of other flags. | `acceptedNamesAreSafe` | `cliOutputNames` |
| P3. The arguments from `--`, or from an application command that is the first remaining argument, stay unchanged and in order. An application command anywhere else does not stop the reading. | `argumentsAfterTheStopStay` | `cliOutputArguments` |
| P4. When the arguments have output flags with valid values, the form is the last one's form. | `lastOutputFlagWins` | `cliOutputArguments` |
| P5. A value flag with no value, or with an unknown value, stops the command line with exit code 3 and gives no form. | `badValueStops` | `cliOutputArguments` |
| P6. An accepted alias has no space at its start or end, and at most one space; a flag alias has no space. Its first word is not a command or a flag of the command line, and its name is not a capability's command path. So the first one or two arguments tell which alias runs, and an alias never takes the place of another command. | `acceptedAliasNamesAreSafe` | `cliAliasNames` |

The bounds are `MOST_SEGMENTS`, `MOST_AFTER` and `MOST_NAMES` in each module, with the domains next to them. Larger bounds prove more cases and take more time.

- `cliOutputNames`: up to 2 output flags, each with up to 2 names from 9 names (valid, invalid and taken), and 4 kinds of flags.
- `cliAliasNames`: one capability alias with one of 13 names: one word, two words, a flag alias, names with a bad space, and names whose first word is taken.
- `cliOutputArguments`: up to 2 output flags, each with up to 2 names from 4 valid names, and 4 kinds of flags; up to 3 argument segments (a plain word, an application command name, or an output flag in each style); a stop (`--` or an application command); up to 1 argument after the stop; a value flag with no value or an unknown value; and an environment with `CI` and one coding-agent variable.

## Cases

[`cli-output-cases.qnt`](cli-output-cases.qnt) produces every case of a bounded domain, with the model's result:

- Automatic form: each terminal state, with each one-variable environment (`CI` or a coding-agent variable) and each of 19 values. The values include each character of `TRIM_CHARACTERS`, plus U+0085 and U+FEFF, which the trim keeps.
- Check: each output flag with up to 2 names from 16 names and 3 kinds, and each pair of flags with one name each.
- Reading: each list of up to 2 arguments from 20 arguments, and each list of 3 arguments from 8 arguments, with and without an application command. The arguments include every form that the reading accepts: `--format text`, `--format=json`, `--format=`, `-f text`, `-f=text`, `--json`, `--json=`, `-H`, `--human`, and a flag with the values `high`, `1` and `2`.
- Form choice: each default, terminal state, 4 environments and 6 argument lists, with the form, or the exit code and the message.
- Help: the line for 7 output flags, with values given out of code point order.

[`cli-alias-cases.qnt`](cli-alias-cases.qnt) produces every case of a bounded domain of aliases, against a fixed catalog with 4 capabilities and 3 events:

- Target: each kind of `options.cli`, with and without the `cli` binding.
- One alias: each of 20 names (including two-word names), each of 24 values, and 4 default aliases (none, not text, the alias, and a name that is not an alias).
- Two aliases: each pair of 6 names in reverse order, including a one-word alias and a two-word alias that starts with that word, with each pair of 6 values and the second name as the default alias.

## Generated files

For each core, `moon run model:generate` writes:

- The shared facts from [`facts.qnt`](#shared-facts), into spec-ts and the Rust core.
- The data: the CI and coding-agent variables, the false values, the characters that the trim removes, the program flags (`--help`, `--version`), the flags of `watch`, the reserved flags with their descriptions, the exit code for a bad value, the template of each message (the output-flag messages and the messages for a view that the command line cannot serve) and of each help line, the form names, and the words and separators of lists.
- The cases: automatic form, check, reading, form choice and help, each with its expected result.
- The alias cases, into spec-ts and the Rust core, each with its errors, accepted aliases and default alias.

The generator fails on a model value it does not know, such as a new variant.

## Add a core

1. Add an emitter for the core's language to [`scripts/generate.ts`](scripts/generate.ts). It writes the shared facts from [`facts.qnt`](facts.qnt), unless the core imports them from a package that has them, and the data, in the language's style. The first line of each file says that the file is generated, and by which command. Add the paths of the data and of a copy of the cases to the list of outputs and to the inputs of the `check` task. Add the copy of the cases to the inputs of the core's `test` task.
2. Use the generated facts and data in the core instead of its own constants and texts. Fill the message and help templates, trim only `TRIM_CHARACTERS`, change the case of ASCII letters only, and sort values by code point.
3. Add one test that reads the cases file and runs each case against the core's pure functions: the automatic form, the output-flag check, argument reading, form choice, and help. The test compares each result exactly, messages and exit codes included. Put the test where the core's package does not need the cases file, for example in a Rust crate's integration tests.
