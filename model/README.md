# Models

Formal models, written in [Quint](https://quint-lang.org), of the rules that every core must follow the same way, and the facts the cores share: names, numbers and message templates. This README is for maintainers of the cores.

## Why the models exist

Each core must parse the same arguments, accept the same aliases and print the same messages. Hand-written copies of a rule drift apart, so each shared rule has one source, the model, and every core is tested against it:

- `quint test` runs the model's examples.
- `quint verify` uses the Apalache model checker to prove the model's properties for every input in small finite domains.
- A generator writes, for each core, the rule's data and every case of a bounded domain with its expected result. Each core runs every case against its own functions and must give the same result.

`quint test` and the generator use Quint's TypeScript backend (`--backend=typescript`). The default Rust backend downloads an evaluator from the GitHub API on first run, and that API rate-limits unauthenticated requests.

The project lives in `model/`, not in `packages/`, because it is the source of files in several packages. It is not published.

## Change a rule or a fact

Change the model first, generate, then fix each core. Never edit a generated file by hand: `moon run model:check` fails when a generated file differs from the model's output.

To change a shared fact, edit [`facts.qnt`](facts.qnt), run `moon run model:generate`, and fix the code that the new value breaks.

To change a rule:

1. Change the model. Add an example to its `run` tests, and a property when clients rely on the rule as a guarantee.
2. Run `moon run model:test` and `moon run model:prove`.
3. Run `moon run model:generate`. It writes the files in [Generated files](#generated-files).
4. If the model has a new value in the data or a new kind of case, update [`scripts/generate.ts`](scripts/generate.ts) and each core's case test.
5. Change each core's functions until its case test passes.

The case tests:

- Each core has one test that reads its `cli-output` cases file.
- `packages/spec-ts/test/alias-cases.test.ts` runs the alias cases against `cliAliases`, which `@acid-cat/core-ts`, `@acid-cat/core-effect` and `acid-cat check` use.
- `packages/core-rust/src/cli/alias_cases.rs` runs them against `cli_aliases`. It is a unit test because `cli_aliases` is private, and Cargo compiles it only for tests, so the crate builds without the cases file.

## Tasks

| Task | What it does |
| --- | --- |
| `moon run model:test` | Run the models' examples and type-check the other modules. |
| `moon run model:prove` | Prove each property with `quint verify`. `moon run model:prove -- lastOutputFlagWins` proves only the named properties. |
| `moon run model:generate` | Write the facts, the data and the cases into spec-ts and each core. |
| `moon run model:check` | Run `test`, then fail if a generated file is not the model's output. `moon run verify` runs it. |

`moon run verify` does not run `model:prove`. The workflow `prove.yml` proves each property in its own job when a pull request changes `model/`, `.prototools` or `pnpm-lock.yaml`. The proofs read only the model, so a core's code cannot change their result; the case tests check the code.

`model:prove` starts one Apalache server per 7 GB of memory, up to one per property, and runs them in parallel. With 30 GB and 22 cores it takes about 7 minutes. The longest proof takes about 5.5 minutes and uses up to about 1.8 GB. Apalache runs on Java, which proto installs from [`.prototools`](../.prototools). `quint verify` downloads Apalache into `~/.quint` on first run.

## What the models cover

| Module | Models | Spec |
| --- | --- | --- |
| [`cli-output.qnt`](cli-output.qnt) | Output flags and the automatic form: the startup check of the output flags, reading them from the arguments, choosing the form, and their messages and help lines. | [CLI binding](../spec/bindings/cli.md) |
| [`cli-aliases.qnt`](cli-aliases.qnt) | The check of a target's aliases: errors, accepted aliases and the default alias. | [Aliases](../spec/bindings/cli.md#aliases) |
| [`facts.qnt`](facts.qnt) | [Shared facts](#shared-facts). | |
| [`cli-output-properties.qnt`](cli-output-properties.qnt), [`cli-alias-properties.qnt`](cli-alias-properties.qnt) | [Properties](#properties). | |
| [`cli-output-cases.qnt`](cli-output-cases.qnt), [`cli-alias-cases.qnt`](cli-alias-cases.qnt) | The bounded domains of the [cases](#cases). | |

### Output flags and the automatic form

The rules of `cli-output.qnt` that a core must match exactly:

- The automatic form is human when standard output is a terminal and neither `CI` nor a coding-agent variable is truthy. A value is false when it is `""`, `0`, `false`, `no` or `off` after trimming only `TRIM_CHARACTERS` (space and U+0009 to U+000D) and folding only ASCII case.
- A first argument `--` is ignored. Reading stops at the next `--`, and at an application command that is the first remaining argument.
- The forms are `--name value`, `--name=value` and `-x value`; `-x=value` is not an output flag. The last flag wins. A missing or unknown value exits with code 3.
- The form is the output flag's, else `json`, else the automatic form when the default is `auto`.
- A list joins its last two items with a word and the others with `, `. Values in messages and help are in code point order.

The model does not cover the human layout, the formatters, process I/O, or the names of commands and flags that the application adds. Each core's tests and startup checks cover those.

`cli-aliases.qnt` reports only the first problem of each alias, in code point order of the names, as a key of `ALIAS_MESSAGES` and the parts that fill it. Its input is abstract: each capability and event has an id, whether it is in the view, and whether its input schema has properties.

### How the models represent text

Quint has no string operations. A text that a rule reads character by character is a list of characters, such as `["-", "-", "j", "s", "o", "n"]`. A text that the rules only write is a list of pieces. Quint strings have no escapes, so a control character or Unicode space is written in angle brackets, such as `<TAB>`; the generator writes the real character.

A message template has a named placeholder for each part, such as `The option {name} must be {values}.` Each core has one function that fills templates.

## Shared facts

[`facts.qnt`](facts.qnt) holds facts that most rules do not read, so they need no proofs. `cli-output.qnt` imports it for the program flags, the flags of `watch` and the exit codes. The generator writes the facts into `packages/spec-ts/src/facts.generated.ts`, which both TypeScript cores import, and into `packages/core-rust/src/facts_generated.rs`.

| Quint name | Fact | spec-ts | acid-cat-core |
| --- | --- | --- | --- |
| `CALL_FAILURE_KINDS` | Call failure kinds, in order of precedence | same | `Kind::as_str` |
| `CLI_EXIT_CODES` | Exit code of each outcome | same | `cli::exit` |
| `CLI_WATCH_EXIT_CODES` | Exit code of each way a subscription ends | same | `cli::exit` |
| `HTTP_STATUS` | HTTP status of each call failure kind | same | `Kind::http_status` |
| `CLI_GENERIC_COMMANDS` | Commands of the command line | same | `GENERIC_COMMANDS` |
| `PROGRAM_FLAGS` | Program flags | `CLI_RESERVED_FLAGS` | `PROGRAM_FLAGS` in `cli/output_generated.rs` |
| `RESUME_FLAGS` | Flags of `watch` | `CLI_RESUME_FLAGS`, without `--` | `RESUME_FLAGS` in `cli/output_generated.rs` |
| `KEEPALIVE_MS` | Time after which a stream sends a keepalive | same | read by `remote::KEEPALIVE` |
| `INTERRUPT_GRACE_MS` | Time after an interrupt before the command line exits with code 130 | same | read by `cli::INTERRUPT_GRACE` |
| `SSE_MEDIA_TYPE` | Media type of server-sent events | same | same |
| `MCP_PROTOCOL_VERSION` | MCP revision | same | read by `mcp::PROTOCOL_VERSION` |
| `MCP_PROTOCOL_VERSION_KEY` | Key of the revision in `_meta` | same | same |
| `MCP_EVENTS_EXTENSION` | Name of the MCP events extension | same | same |
| `MCP_SUBSCRIPTION_ID` | Key of the subscription id in `_meta` | same | same |
| `MCP_UNKNOWN_TOOL` | JSON-RPC error for an unknown tool | same | same |
| `MCP_HEADER_MISMATCH` | JSON-RPC error `HeaderMismatch`, for a header that does not agree with the body | same | same |
| `MCP_NAMED_METHODS` | Methods whose requests have an `Mcp-Name` header | same | same |
| `MCP_HEARTBEAT_MIN_MS`, `MCP_HEARTBEAT_MAX_MS` | Bounds of the heartbeat interval that a server grants for a suggestion | same | same |
| `MCP_SERVER_CARD_PATH`, `MCP_SERVER_CARD_MEDIA_TYPE`, `MCP_SERVER_CARD_SCHEMA`, `MCP_SERVER_CARD_CACHE_CONTROL` | Path suffix, media type, `$schema` and `Cache-Control` of the MCP Server Card | same | same |
| `MCP_SERVER_CARD_CORS_HEADERS` | CORS headers of the MCP Server Card | same | same |
| `MCP_SERVER_CARD_NAME_MIN_LENGTH`, `MCP_SERVER_CARD_NAME_MAX_LENGTH`, `MCP_SERVER_CARD_DESCRIPTION_MAX_LENGTH`, `MCP_SERVER_CARD_VERSION_MAX_LENGTH` | Length limits, in characters, of the name, the description and the version of the MCP Server Card | same | same |
| `MCP_SERVER_CARD_NAME_PART_MAX_LENGTH` | Length limit, in characters, of each part of the default name of the MCP Server Card | same | same |
| `MCP_EVENT_ERRORS` | JSON-RPC errors of the events extension | same | `event_errors` |
| `MCP_REJECTIONS` | HTTP status and JSON-RPC error of each request rejection | same | `Rejection::status`, `Rejection::rpc_code` |
| `ALIAS_MESSAGES` | Messages for a target's aliases | same, filled by `cliAliases` | one `*_MESSAGE` constant per message |
| `START_MESSAGES` | Messages for a view the command line cannot serve | none: `MESSAGES` in each TypeScript core's generated output file | one `*_MESSAGE` constant per message in `cli/output_generated.rs` |

In the Rust file, a `match` on `Kind` or `Rejection` fails to compile when the enum and the model have different variants.

## Properties

Each properties module chooses its inputs with `nondet` from small finite domains in `init`, and `quint verify --max-steps=0` proves each invariant for every choice. `readOutputFlags` reads the arguments after the program drops a first `--`; `outputChoice` is `programArguments` followed by `readOutputFlags`.

| Invariant | Module | Guarantee |
| --- | --- | --- |
| `notTerminalGivesJson` | `cliOutputArguments` | Off a terminal, with no output flag before the stop, the form is JSON for each default and the arguments stay unchanged and in order. |
| `acceptedNamesAreSafe` | `cliOutputNames` | Accepted output flag names are unique, well formed, not `--`, free of `=`, and not the names of other flags. |
| `argumentsAfterTheStopStay` | `cliOutputArguments` | The arguments from the stop on stay unchanged and in order. An application command elsewhere does not stop the reading. |
| `lastOutputFlagWins` | `cliOutputArguments` | With valid output flags, the form is the last one's. |
| `badValueStops` | `cliOutputArguments` | A value flag with no value or an unknown value exits with code 3 and gives no form. |
| `acceptedAliasNamesAreSafe` | `cliAliasNames` | An accepted alias name has at most one inner space (none for a flag alias), its first word is not a command or flag of the command line, and it is not a capability's command path. So the first one or two arguments tell which alias runs, and an alias never hides another command. |

The bounds are `MOST_SEGMENTS`, `MOST_AFTER` and `MOST_NAMES` in each module, with the domains next to them. Larger bounds prove more and take longer.

## Cases

[`cli-output-cases.qnt`](cli-output-cases.qnt) and [`cli-alias-cases.qnt`](cli-alias-cases.qnt) list every case of a bounded domain with the model's result. The output cases cover the automatic form (including U+0085 and U+FEFF, which the trim keeps), the flag check, reading, form choice and help lines. Each core reads `CI` and the coding-agent variables with one function, so the automatic-form cases give every test value to `CI`, and one true and one false value to each coding-agent variable. The alias cases run against a fixed catalog with 4 capabilities and 3 events, with one alias, pairs of aliases (such as `fan` and `fan high`), each kind of `options.cli`, and several default aliases. Read the modules for the exact domains.

## Generated files

`moon run model:generate` writes:

| Core | Data | Cases |
| --- | --- | --- |
| `@acid-cat/spec-ts` | `packages/spec-ts/src/facts.generated.ts` | `packages/spec-ts/test/fixtures/cli-alias-cases.json` |
| `@acid-cat/core-ts` | `packages/core-ts/src/cli-output.generated.ts` | `packages/core-ts/test/fixtures/cli-output-cases.json` |
| `@acid-cat/core-effect` | `packages/core-effect/src/internal/output.generated.ts` | `packages/core-effect/test/fixtures/cli-output-cases.json` |
| `acid-cat-core` | `packages/core-rust/src/facts_generated.rs`, `packages/core-rust/src/cli/output_generated.rs` | `packages/core-rust/tests/fixtures/cli_output_cases.json`, `packages/core-rust/tests/fixtures/cli_alias_cases.json` |

The data holds the variables, false values and trim characters of the automatic form, the program, `watch` and reserved flags, the bad-value exit code, every message and help template, the form names, and the list words. The generator fails on a model value it does not know, such as a new variant.

## Add a core

1. Add an emitter to [`scripts/generate.ts`](scripts/generate.ts). It writes the data and, unless the core imports them from a package, the shared facts, in the language's style. Each file's first line says it is generated, and by which command. Add the data and cases paths to the outputs and to the inputs of the `check` task, and the cases path to the inputs of the core's `test` task.
2. Use the generated facts and data instead of the core's own constants. Fill the templates, trim only `TRIM_CHARACTERS`, fold only ASCII case, and sort values by code point.
3. Add one test that runs each case against the core's pure functions (automatic form, output flag check, reading, form choice and help) and compares each result exactly, messages and exit codes included. Put it where the package does not need the cases file, such as a Rust crate's integration tests.
