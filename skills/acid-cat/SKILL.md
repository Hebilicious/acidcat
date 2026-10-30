---
name: acid-cat
license: MIT
description: |
  Build an application with AcidCat: write its catalog (in Pkl, with a catalog library, or from the code of a core), implement its capabilities with a core (@acid-cat/core-ts, @acid-cat/core-effect, acid-cat-core-kotlin), serve them through bindings (MCP through HTTP or stdio, HTTP, command line, WebMCP, Android AppFunctions), and test them with acid-cat check and acid-cat conform. Use when a repository depends on @acid-cat/* or dev.acidcat:*, has a *.acidcat.json catalog or a Pkl module that amends Catalog.pkl, or when the user asks to add a capability, a target or a binding, to expose an application to agents through MCP, WebMCP or AppFunctions, or to give it a command line or an HTTP API.
---

# AcidCat

AcidCat describes what an application can do in one document, the **catalog**. Each surface of the application, for example a command line, an MCP server, a web page or the app functions of an Android app, comes from the catalog through a **binding**. A **core** runs the operations. `acid-cat conform` tests each binding from outside.

The specification is at https://github.com/Hebilicious/acidcat/tree/main/spec. Read its vocabulary before you name things: https://github.com/Hebilicious/acidcat/blob/main/spec/README.md#vocabulary.

## Rules

- **The catalog is the contract.** Change the catalog first, then the code. A capability that is not in the catalog does not exist for a client.
- **Never write or change the JSON of a catalog by hand.** The JSON is an output. Write its source: a Pkl module that amends `Catalog.pkl`, a program with a catalog library, or the code of the application when a core writes the catalog. Then write the JSON again. `acid-cat format` writes the canonical form.
- **Ids are names, not versions.** An id is two or more segments with dots between them: `aircon.power.set`. Each segment matches `[a-z][a-z0-9]*(-[a-z0-9]+)*`. Do not change the meaning of an id. Give a new meaning a new id.
- **Each audience is explicit.** A capability with no audience is available to no target. Give agents (`mcp`, WebMCP, AppFunctions targets) only the capabilities that they must have.
- **A failure is data.** Declare each failure that a capability can return, by tag, in `failures`. A failure value has its tag in `_tag`. A defect (an exception) becomes the call failure `internal`, and its details stay on the server.
- **Inputs carry no identity.** No user id, token or credential in an input. The session holds the identity of the client.
- **Descriptions are for people and for agents.** Tell what the capability does, its effects, and the effects that stay after a cancellation.
- **The core validates each input.** Do not validate the input again in `run`. Put each constraint in the schema (`minimum`, `maxLength`, `enum`, …) so that the catalog, the agents and the validation agree.

## Where the catalog comes from

| Situation | Source of the catalog | Command that writes the JSON |
| --- | --- | --- |
| One application with one core | The code: the core writes the catalog from its capabilities | `renderCatalog(app, { toJsonSchema })` (core-ts), `App.render(app)` (core-effect), `app.renderCatalog()` (Kotlin) |
| A catalog that several implementations share, for example a server in TypeScript and an Android app in Kotlin | A Pkl module, or a program with a catalog library | `pkl eval <module>`, then `acid-cat format --write`; or the program of the library |

When several implementations share one catalog, each implementation has a test that compares its own catalog with the shared catalog: the same targets, and for each capability the same audience, failure tags, `readOnly` and `state`. `examples/aircon` in the repository does this for three cores.

Commit the source and the JSON together. Add a check to the build that writes the JSON again and fails when it differs.

## Choose a core

| Core | Package | Style |
| --- | --- | --- |
| TypeScript | npm `@acid-cat/core-ts` | A capability returns a promise. Schemas are any Standard Schema library, for example Zod |
| Effect | npm `@acid-cat/core-effect` | A capability is an Effect program with Effect Schema. Sessions are scopes, services are layers |
| Kotlin | Maven `dev.acidcat:acid-cat-core-kotlin` | A capability is a suspending function. Schemas come from serializable Kotlin types. JVM and Android |

A core in another language follows the specification and passes `acid-cat conform`. It does not use these packages.

## Add a capability

1. Add it to the source of the catalog: id, description, audience, input, output, failures, `readOnly`, `state`.
2. Implement it in the core. See [references/cores.md](references/cores.md) for each core.
3. Write the JSON of the catalog again, and run `acid-cat check --strict <catalog>`.
4. Run the tests of the application, and `acid-cat conform` for each binding that the application serves.

## Serve a binding

Each target of the catalog lists its bindings. Each binding serves the **view** of its target: only the capabilities whose audience has the target.

| Binding | Surface | core-ts | core-effect | Kotlin |
| --- | --- | --- | --- | --- |
| `typescript`, `kotlin` | Handles in code, for a user interface | `createSession` | `Session.make`, `Handles.make` | `app.openSession` |
| `mcp` through HTTP | An MCP server at `/mcp` | `mcpHandler` | `Mcp.toWebHandler` | `mcpHandler`, with `acid-cat-ktor` |
| `mcp` through stdio | A local MCP server that a client starts | `mcpStdioMain` | `NodeMcp.main` | `mcpStdioMain` |
| `http` | JSON at `POST /capabilities/<id>` | `httpHandler` | `Http.toWebHandler` | `httpHandler` |
| `cli` | A command for each capability | `cliMain` | `NodeCli.main` | `cliMain` |
| `webmcp` | Tools of a web page for the agents of the browser | `installWebMcp` | `WebMcp.install` | — |
| `appfunctions` | App functions of an Android app | — | — | `acid-cat-appfunctions` and the Gradle plugin `dev.acidcat.appfunctions` |

See [references/bindings.md](references/bindings.md) for the options and the traps of each binding.

## Test

```sh
acid-cat check --strict catalog.acidcat.json   # the catalog conforms, and is in canonical form
acid-cat view catalog.acidcat.json mcp          # the view of one target
acid-cat conform --mcp http://127.0.0.1:3000/mcp --http http://127.0.0.1:3000/api \
  --cli "node cli.ts" --mcp-stdio "node mcp.ts"  # each binding of a running implementation
```

`acid-cat` is the npm package `@acid-cat/cli`. `acid-cat conform` tests an implementation of the conformance fixture, not of your catalog. Run it in the tests of a new core or a new binding. For an application, test the capabilities through a session, and the surfaces through the bindings.

## Common mistakes

- A JSON catalog that a person changed, and that its source no longer writes.
- A capability for agents with no `failures`: the agent cannot tell "the unit is offline" from a defect.
- A number schema with no limits for a value that has limits. The agent sends values that the operation cannot use.
- An input with a user id. Use the session instead.
- Writing to standard output from a capability that an MCP server through stdio serves. Standard output carries only MCP messages.
- A long operation with no cancellation. Each core cancels the call when the client goes away. Stop the work when the signal (core-ts), the fiber (core-effect) or the coroutine (Kotlin) is cancelled.
