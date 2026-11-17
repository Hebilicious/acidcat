# Models

This Moon project holds the formal models of the rules that each core follows. The models are written in [Quint](https://quint-lang.org). A model is the single source of a rule:

- `quint test` runs the examples of the model.
- `quint verify` proves the properties of the model with the Apalache model checker, for every input of small finite domains.
- A generator writes, from the model, the data of the rule for each core, and every case of a bounded domain with its expected result. Each core runs every case against its own functions, and must give the same result.

The project is not a package. No registry receives it. It is in `model/` at the root of the repository, and not in `packages/`, because it is the source of files in several packages.

## What the models cover

[`cli-output.qnt`](cli-output.qnt) models the output flags and the automatic form of the CLI binding ([spec/bindings/cli.md](../spec/bindings/cli.md)):

- The automatic form: human when standard output is a terminal, `CI` is not truthy, and no variable of a coding agent is truthy. A variable is truthy when it is set to a value that is not `""`, `0`, `false`, `no` or `off`, after trimming and in any case. Trimming removes only the characters of `TRIM_CHARACTERS`: space, U+0009, U+000A, U+000B, U+000C and U+000D. The case changes only for the ASCII letters `A` to `Z`.
- The check of the output flags when the command line starts, with its messages: a flag with no name, a name that is not valid, a name of another output flag, a name of another flag of the command line, and a flag with no values.
- The reading of the output flags in the arguments: until the first `--`, and until an application command that is the first remaining argument; `--name value`, `--name=value` and `-x value`; `-x=value` is not an output flag; the last flag wins; a missing or unknown value stops the command line with exit code 3.
- The choice of the form: an output flag, else the default `json`, else the automatic form for the default `auto`.
- The messages, the line of the help of each output flag, and the lists in them. A list joins its last two items with a word and the others with `, `: `a, b or c`. The message of a bad value and the help give the values in code point order.

The model does not cover the human layout, the formatters, or the input and output of the process. The tests of each core cover them.

Quint has no operations on strings. A text that a rule reads character by character is a list of characters, for example `["-", "-", "j", "s", "o", "n"]`. A text that the rules only write, such as a message, is a list of pieces. Quint strings have no escapes, so the model writes a control character or a Unicode space in angle brackets, for example `<TAB>`. The generator writes the real character. The template of a message is the message with a placeholder for each part, for example `The option {name} must be {values}.`

## Properties

[`cli-output-properties.qnt`](cli-output-properties.qnt) has two state machines. Each one chooses its inputs with `nondet` from small finite domains in `init`. `quint verify --max-steps=0` then proves each invariant for every choice.

| Property | Invariant | Module |
| --- | --- | --- |
| P1. Off a terminal, with no output flag before the stop, the form is JSON for each default, and the arguments stay unchanged and in order. The arguments after `--`, or after an application command that is the first remaining argument, can be output flags. | `notTerminalGivesJson` | `cliOutputArguments` |
| P2. An accepted configuration has names that are unique, well formed, not `--`, with no `=`, and not the names of other flags. | `acceptedNamesAreSafe` | `cliOutputNames` |
| P3. The arguments from `--`, or from an application command that is the first remaining argument, stay unchanged and in order. An application command in another place does not stop the reading. | `argumentsAfterTheStopStay` | `cliOutputArguments` |
| P4. When the arguments have output flags with valid values, the form is the form of the last one. | `lastOutputFlagWins` | `cliOutputArguments` |
| P5. A value flag with no value, or with an unknown value, stops the command line with exit code 3, and gives no form. | `badValueStops` | `cliOutputArguments` |

The bounds are `MOST_SEGMENTS`, `MOST_AFTER` and `MOST_NAMES` in the module, and the domains beside them. Larger bounds prove more cases, and take more time.

- `cliOutputNames`: up to 2 output flags, each with up to 2 names from 9 names (valid, not valid and taken), and 4 kinds of flags.
- `cliOutputArguments`: up to 2 output flags, each with up to 2 names from 4 valid names, and 4 kinds of flags; up to 3 segments of arguments (a plain word, the name of an application command, or a use of an output flag in each style); a stop (`--` or an application command); up to 1 argument after the stop; a value flag with no value or an unknown value; and an environment with `CI` and one variable of a coding agent.

## Cases

[`cli-output-cases.qnt`](cli-output-cases.qnt) makes every case of a bounded domain, with the result of the model:

- The automatic form: each terminal state, with each environment of one variable (`CI` or a variable of a coding agent) and each of 19 values. The values include each character of `TRIM_CHARACTERS`, and U+0085 and U+FEFF, which the trim keeps.
- The check: each output flag with up to 2 names from 16 names and 3 kinds, and each pair of flags with one name each.
- The reading: each list of up to 2 arguments from 20 arguments, and each list of 3 arguments from 8 arguments, with and without an application command. The arguments include each form that the reading takes: `--format text`, `--format=json`, `--format=`, `-f text`, `-f=text`, `--json`, `--json=`, `-H`, `--human`, and a flag with the values `high`, `1` and `2`.
- The choice of the form: each default, terminal state, 4 environments and 6 lists of arguments, with the form or the exit code and the message.
- The help: the line of 7 output flags, with values in an order that is not the code point order.

## Tasks

| Task | What it does |
| --- | --- |
| `moon run model:test` | Run the examples of the model, and type-check the other modules. |
| `moon run model:prove` | Prove each property with `quint verify`. It runs one Apalache server for each 7 GB of memory, up to one for each property, and proves the properties in parallel. On a computer with 30 GB of memory and 22 cores, it takes about 7 minutes. The longest proof takes about 5.5 minutes, and its Java and Z3 processes use up to about 1.8 GB. |
| `moon run model:generate` | Write the data and the cases into each core. |
| `moon run model:check` | Run `test` and `prove`, then fail if a file in a core is not the output of the model. `moon run verify` runs it. |

Apalache runs on Java. proto installs Java from [`.prototools`](../.prototools). `quint verify` downloads Apalache into `~/.quint` the first time that it runs.

## Generated files

`moon run model:generate` writes, for each core:

- The data: the variables of CI and of the coding agents, the false values, the characters that the trim removes, the flags of the program (`--help`, `--version`), the flags of `watch`, the reserved flags with their descriptions, the exit code of a bad value, the template of each message and of each line of the help, the names of the forms, and the words and separators of the lists.
- The cases: the automatic form, the check, the reading, the choice of the form and the help, each with its expected result.

The generator fails when the flags of the program, the flags of `watch` or the exit code of the model differ from `CLI_RESERVED_FLAGS`, `CLI_RESUME_FLAGS` or `CLI_EXIT_CODES["invalid-input"]` of `@acid-cat/spec-ts`. It also fails on a value of the model that it does not know, for example a new variant.

## Change a rule

1. Change the model. Add an example to its `run` tests, and a property when the rule is a guarantee that clients rely on.
2. Run `moon run model:test` and `moon run model:prove`.
3. Run `moon run model:generate`. It writes these files:

   | Core | Data | Cases |
   | --- | --- | --- |
   | `@acid-cat/core-ts` | `packages/core-ts/src/cli-output.generated.ts` | `packages/core-ts/test/fixtures/cli-output-cases.json` |
   | `@acid-cat/core-effect` | `packages/core-effect/src/internal/output.generated.ts` | `packages/core-effect/test/fixtures/cli-output-cases.json` |
   | `acid-cat-core` | `packages/core-rust/src/cli/output_generated.rs` | `packages/core-rust/tests/fixtures/cli_output_cases.json` |

4. When the model has a new value in the data or a new kind of case, change the emitters and the readers of [`scripts/generate.ts`](scripts/generate.ts), and the test of the cases in each core.
5. Change the functions of each core until its test of the cases passes. Do not change a generated file by hand. `moon run model:check` fails when a generated file is not the output of the model.

## Add a core

1. Add an emitter for the language of the core to [`scripts/generate.ts`](scripts/generate.ts): the data, in the style of the language, with a first line that tells that the file is generated, and by which command. Add the paths of the data and of a copy of the cases to the list of outputs, and to the inputs of the task `check`. Add the copy of the cases to the inputs of the task `test` of the core.
2. Use the generated data in the core, in place of its own constants and texts: fill the templates of the messages and of the help, trim only `TRIM_CHARACTERS`, change the case of ASCII letters only, and sort the values by code point.
3. Add one test that reads the cases file and runs each case against the pure functions of the core: the automatic form, the check of the output flags, the reading of the arguments, the choice of the form, and the help. The test compares each result exactly, messages and exit codes included. Put the test where the package of the core does not need the cases file, for example in the integration tests of a Rust crate.
