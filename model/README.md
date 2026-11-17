# Models

This Moon project holds the formal models of the rules that each core follows. The models are written in [Quint](https://quint-lang.org). A model is the single source of a rule:

- `quint test` runs the examples of the model.
- `quint verify` proves the properties of the model with the Apalache model checker, for every input of small finite domains.
- A generator writes, from the model, the data of the rule for each core, and every case of a bounded domain with its expected result. Each core runs every case against its own functions, and must give the same result.

The project is not a package. No registry receives it. It is in `model/` at the root of the repository, and not in `packages/`, because it is the source of files in several packages.

## What the models cover

[`cli-output.qnt`](cli-output.qnt) models the output flags and the automatic form of the CLI binding ([spec/bindings/cli.md](../spec/bindings/cli.md)):

- The automatic form: human when standard output is a terminal, `CI` is not truthy, and no variable of a coding agent is truthy. A variable is truthy when it is set to a value that is not `""`, `0`, `false`, `no` or `off`, after trimming and in any case.
- The check of the output flags when the command line starts, with its messages: a flag with no name, a name that is not valid, a name of another output flag, a name of another flag of the command line, and a flag with no values.
- The reading of the output flags in the arguments: until the first `--`, and until an application command that is the first remaining argument; `--name value`, `--name=value` and `-x value`; the last flag wins; a missing or unknown value stops the command line with exit code 3.

The model does not cover the text of the help, the human layout, the formatters, or the input and output of the process. The tests of each core cover them.

Quint has no operations on strings. A text that a rule reads character by character is a list of characters, for example `["-", "-", "j", "s", "o", "n"]`. The characters of the domains are ASCII. The model trims spaces only. Each core trims all whitespace and changes the case of all letters with the functions of its language.

## Properties

[`cli-output-properties.qnt`](cli-output-properties.qnt) has two state machines. Each one chooses its inputs with `nondet` from small finite domains in `init`. `quint verify --max-steps=0` then proves each invariant for every choice.

| Property | Invariant | Module |
| --- | --- | --- |
| P1. Off a terminal, with no output flag in the arguments, the form is JSON for each default. | `notTerminalGivesJson` | `cliOutputArguments` |
| P2. An accepted configuration has names that are unique, well formed, not `--`, with no `=`, and not the names of other flags. | `acceptedNamesAreSafe` | `cliOutputNames` |
| P3. The arguments from `--`, or from an application command that is the first remaining argument, stay unchanged and in order. | `argumentsAfterTheStopStay` | `cliOutputArguments` |
| P4. When the arguments have output flags with valid values, the form is the form of the last one. | `lastOutputFlagWins` | `cliOutputArguments` |
| P5. A value flag with no value, or with an unknown value, stops the command line with exit code 3, and gives no form. | `badValueStops` | `cliOutputArguments` |

The bounds are `MOST_SEGMENTS`, `MOST_AFTER` and `MOST_NAMES` in the module, and the domains beside them. Larger bounds prove more cases, and take more time.

- `cliOutputNames`: up to 2 output flags, each with up to 2 names from 9 names (valid, not valid and taken), and 4 kinds of flags.
- `cliOutputArguments`: up to 2 output flags, each with up to 2 names from 4 valid names, and 4 kinds of flags; up to 2 segments of arguments (a plain word, or a use of an output flag in each style); a stop (`--` or an application command); up to 1 argument after the stop; a value flag with no value or an unknown value; and an environment with `CI` and one variable of a coding agent.

## Cases

[`cli-output-cases.qnt`](cli-output-cases.qnt) makes every case of a bounded domain, with the result of the model:

- The automatic form: each terminal state, with each environment of one variable (`CI` or a variable of a coding agent) and each of 12 values.
- The check: each output flag with up to 2 names from 16 names and 3 kinds, and each pair of flags with one name each.
- The reading: each list of up to 3 arguments from 10 arguments, with and without an application command.

## Tasks

| Task | What it does |
| --- | --- |
| `moon run model:test` | Run the examples of the model, and type-check the other modules. |
| `moon run model:prove` | Prove each property with `quint verify`. It runs one Apalache server for each 7 GB of memory, up to one for each property, and proves the properties in parallel. |
| `moon run model:generate` | Write the data and the cases into each core. |
| `moon run model:check` | Run `test` and `prove`, then fail if a file in a core is not the output of the model. `moon run verify` runs it. |

Apalache runs on Java. proto installs Java from [`.prototools`](../.prototools). `quint verify` downloads Apalache into `~/.quint` the first time that it runs.

## Change a rule

1. Change the model. Add an example to its `run` tests, and a property when the rule is a guarantee that clients rely on.
2. Run `moon run model:test` and `moon run model:prove`.
3. Run `moon run model:generate`. It writes these files:

   | Core | Data | Cases |
   | --- | --- | --- |
   | `@acid-cat/core-ts` | `packages/core-ts/src/cli-output.generated.ts` | `packages/core-ts/test/fixtures/cli-output-cases.json` |
   | `@acid-cat/core-effect` | `packages/core-effect/src/internal/output.generated.ts` | `packages/core-effect/test/fixtures/cli-output-cases.json` |
   | `acid-cat-core` | `packages/core-rust/src/cli/output_generated.rs` | `packages/core-rust/tests/fixtures/cli_output_cases.json` |

4. Change the functions of each core until its test of the cases passes. Do not change a generated file by hand. `moon run model:check` fails when a generated file is not the output of the model.

## Add a core

1. Add an emitter for the language of the core to [`scripts/generate.ts`](scripts/generate.ts): the data, in the style of the language, with a first line that tells that the file is generated, and by which command. Add the paths of the data and of a copy of the cases to the list of outputs, and to the inputs of the task `check`.
2. Use the generated data in the core, in place of its own constants.
3. Add one test that reads the cases file and runs each case against the pure functions of the core: the automatic form, the check of the output flags, and the reading of the arguments. The test compares each result exactly, messages included.
