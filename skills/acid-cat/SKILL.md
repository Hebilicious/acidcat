---
name: acid-cat
license: MIT
description: |
  Build an application with AcidCat: write its catalog (in Pkl, with a catalog library, or from the code of a core), implement its capabilities and events with a core (@acid-cat/core-ts, @acid-cat/core-effect, the Rust crate acid-cat-core), serve them through surfaces (MCP through HTTP or stdio, HTTP, command line, WebMCP), and test them with acid-cat check and acid-cat conform. Use when a repository depends on @acid-cat/* or acid-cat-core, has a *.acidcat.json catalog or a Pkl module that amends Catalog.pkl, or when the user asks to add a capability, a target or a surface, to expose an application to agents through MCP or WebMCP, or to give it a command line or an HTTP API.
---

# AcidCat

AcidCat describes what an application can do in one document, the **catalog**, and serves that one catalog through many **surfaces**: MCP, WebMCP, the command line (CLI), HTTP, and languages such as TypeScript and Rust. A **target** is a group of clients and what they can use. The catalog lists the surfaces of each target, and each surface serves only the catalog of its target. A **core** runs your providers and serves the surfaces of each target. `acid-cat conform` tests each protocol surface from outside. A language surface serves code in the same process, so the tests of each core test it.

The specification is at https://github.com/Hebilicious/acidcat/tree/main/spec. Read its vocabulary before you name things: https://github.com/Hebilicious/acidcat/blob/main/spec/README.md#vocabulary.

## Rules

- **The catalog is the contract.** Change the catalog first, then the code. A capability that is not in the catalog does not exist for a client.
- **Prefer a source to JSON by hand.** Write the catalog as a Pkl module that amends `Catalog.pkl`, a program with a catalog library, or the code of the application when a core writes the catalog, and let the tool write the JSON. A source finds errors, shares types and gives the canonical form. JSON by hand is allowed: then run `acid-cat check --strict` and `acid-cat format --write` after each change. When a catalog has a source, never change its JSON: change the source, and write the JSON again.
- **Ids are names, not versions.** An id is two or more segments with dots between them: `aircon.power.set`. Each segment matches `[a-z][a-z0-9]*(-[a-z0-9]+)*`. Do not change the meaning of an id. Give a new meaning a new id.
- **Each audience is explicit.** A capability or an event with no audience is available to no target. Give agents (`mcp` and WebMCP targets) only the capabilities that they must have.
- **Give the hints that are true.** `readOnly`: a call changes nothing. `destructive`: `true` if a call can delete or overwrite something, `false` if a call only adds things. `idempotent`: a second call with the same input has no more effect. Each hint is optional. The MCP surface gives them as `readOnlyHint`, `destructiveHint` and `idempotentHint`, and agent clients use them to decide when to ask the user before a call.
- **A failure is data.** Declare each failure that a capability can return, by tag, in `failures`. A failure value has its tag in `_tag`. A defect (an exception) becomes the call failure `internal`, and its details stay on the server.
- **Inputs carry no identity.** No user id, token or credential in an input. The session holds the identity of the client.
- **Descriptions are for people and for agents.** In one sentence, tell what the capability does, or what the event is and when it happens. Add the effects that stay after a cancellation. Do not repeat the audience, the schemas or the failures.
- **The core validates each input.** Do not validate the input again in `run`. Put each constraint in the schema (`minimum`, `maxLength`, `enum`, …) so that the catalog, the agents and the validation agree.

## Where the catalog comes from

| Situation | Source of the catalog | Command that writes the JSON |
| --- | --- | --- |
| One application with one core | The code: the core writes the catalog from its capabilities | `renderCatalog(app, { toJsonSchema })` (core-ts), `App.render(app)` (core-effect), `app.render_catalog()` (core-rust) |
| A catalog that several implementations share, for example a server in core-effect and a web page in core-ts | A Pkl module, or a program with a catalog library | `pkl eval <module>`, then `acid-cat format --write`; or the program of the library |

When several implementations share one catalog, each implementation has a test that compares its own catalog with the shared catalog: the same targets, and for each capability the same audience, failure tags, `readOnly`, `destructive`, `idempotent` and `state`. `examples/aircon` in the repository does this for each core.

Commit the source and the JSON together. Add a check to the build that writes the JSON again and fails when it differs.

## Choose a core

| Core | Package | Style |
| --- | --- | --- |
| TypeScript | npm `@acid-cat/core-ts` | A capability returns a promise. Schemas are any Standard Schema library, for example Zod |
| Effect | npm `@acid-cat/core-effect` | A capability is an Effect program with Effect Schema. Sessions are scopes, services are layers |
| Rust | crates.io `acid-cat-core` | A capability is an async function on Tokio. Schemas come from types that derive `serde` and `schemars::JsonSchema`. It serves MCP, HTTP and the CLI, not WebMCP |

A core in another language follows the specification and passes `acid-cat conform`. It does not use these packages.

## Add a capability

1. Add it to the source of the catalog: id, description, audience, input, output, failures, `readOnly`, `destructive`, `idempotent`, `state`.
2. Implement it in the core. See [references/cores.md](references/cores.md) for each core.
3. Write the JSON of the catalog again, and run `acid-cat check --strict <catalog>`.
4. Run the tests of the application, and `acid-cat conform` for each protocol surface that the application serves.

## Add an event

An **event** is a thing that happens in the application, that clients follow, for example `aircon.status.changed`. A client subscribes with an input, and gets an **occurrence** each time that the thing happens. Use an event when clients must know about a change as it happens. Use a capability for a call that gives one result.

1. Add it to `events` in the source of the catalog: id, description, audience, input, payload. In Pkl: `events { ["aircon.status.changed"] { … } }`. In a catalog library: `event(id, …)`.
2. Obey the rules: the id is not also the id of a capability. The input and the payload are objects: `"type": "object"`, or a `$ref` to a type that is an object. Put a filter in the input, for example `{ "room": … }`. Put a failure of the source in the payload, as a union with a `_tag`.
3. Implement it in the core: in core-ts, `defineEvent` with a `subscribe` that gives an async iterable; in core-effect, `Event.make` with a `subscribe` that gives a `Stream`; in core-rust, `Event::new(…).subscribe(…)` that gives a `Stream`. See [references/cores.md](references/cores.md).
4. Write the JSON of the catalog again, and run `acid-cat check --strict <catalog>`. The catalog of a target has the events whose audience has the target.

To keep old clients working, add members to a payload, and do not remove or change members. [spec/events.md](https://github.com/Hebilicious/acidcat/blob/main/spec/events.md) tells how subscriptions, occurrences and cursors work. The document of each surface tells how it serves them. The WebMCP surface does not serve events. To follow an event in your own API, with a GraphQL subscription, a Cap'n Web callback or an Elysia stream of server-sent events, see [references/surfaces.md](references/surfaces.md#graphql-subscription-from-an-event).

## Serve a surface

Each target of the catalog lists its surfaces. Each surface serves the **catalog of its target**: only the capabilities and the events whose audience has the target.

| Surface | Surface | core-ts | core-effect | core-rust |
| --- | --- | --- | --- | --- |
| `typescript` | Handles in TypeScript code, for a user interface | `createSession` | `Session.make`, `Handles.make`, `Handles.makeEvents` | None |
| `rust` | The functions of a session in Rust code | None | None | `Session::open`, then `invoke`, `subscribe`, `availability`, `state` |
| `mcp` through HTTP | An MCP server at `/mcp` | `mcpHandler` | `Mcp.toWebHandler` | `mcp::McpSurface` |
| `mcp` through stdio | A local MCP server that a client starts | `mcpStdioMain` | `NodeMcp.main` | `mcp::serve_stdio` |
| `http` | JSON at `POST /capabilities/<id>` | `httpHandler` | `Http.toWebHandler` | `http::HttpSurface` |
| `cli` | A command for each capability, and the aliases of the target | `cliMain` | `NodeCli.main` | `cli::cli_main` |
| `webmcp` | Tools of a web page for the agents of the browser | `installWebMcp` | `WebMcp.install` | None |

The `typescript` and `rust` surfaces are language surfaces. Each one maps the [programmatic surface](https://github.com/Hebilicious/acidcat/blob/main/spec/surfaces/programmatic.md): a session gives a handle for each capability and an event handle for each event of its target. A handle gives an external call, which validates an input that is not trusted, and can give a typed call. A result is data. A call failure has a `kind`. The client reads the latest availability and state, and the surface tells it after each one changes. The client can miss a value between two reads. In TypeScript, availability and state are `Observable` values. In Rust, `availability` and `state` read them, and `availability_changes` and `StateWatch::changed` tell that they changed. The client can cancel each call and each subscription.

The MCP and HTTP surfaces give web handlers. On Node.js, the server of the core serves them: `serve` from `@acid-cat/core-ts/node`, or `NodeServer` from `@acid-cat/core-effect`. In Rust, `remote::serve` of `acid-cat-core` serves them. It is plain HTTP. TLS ends in the platform, before it. These servers close no idle connection, so a client never sends a request on a connection while the server closes it: do not give them an idle timeout. The client or the proxy closes an idle connection. See [references/surfaces.md](references/surfaces.md) for the options and the traps of each surface.

## Test

```sh
acid-cat check --strict catalog.acidcat.json   # the catalog conforms, and is in canonical form
acid-cat target catalog.acidcat.json mcp        # the catalog of one target
acid-cat conform --mcp http://127.0.0.1:3000/mcp --http http://127.0.0.1:3000/api \
  --cli "node cli.ts" --mcp-stdio "node mcp.ts" \
  --webmcp http://127.0.0.1:3000/page            # each protocol surface of a running implementation
```

`acid-cat` is the npm package `@acid-cat/cli`. `acid-cat conform` tests an implementation of the conformance fixture, not of your catalog. It tests the capabilities and the events of the fixture through each protocol surface: outcomes, call failures, occurrences, the ends of a subscription, and cancellation. Through WebMCP, it opens the page in Chromium with a test host (Playwright installs Chromium). Through MCP, it also tests poll delivery, the Server Card when `<mcp>/server-card` gives 200, and with `--webhook-principal`, `--webhook-cert` and `--webhook-key`, webhook delivery, with the `v1a,` signatures of the keys of the card. Give the deployment under test a small poll buffer, a short minimum webhook lifetime and a small limit of webhook subscriptions, and the same values to `--poll-buffer`, `--webhook-min-ttl-ms` and `--webhook-max-subscriptions`, so that conform tests them too. Keep its lease time and its maximum webhook lifetime longer than the deadline of conform: a check uses a lease or a subscription for its whole time. To test the end of a lease, serve a second MCP server with a short lease time, and give it to `--poll-lease-mcp` with `--poll-lease-ms`. For webhooks, the deployment trusts the test certificate, allows private networks, and takes the principal from `Authorization: Bearer <principal>`. Through MCP, conform checks that a heartbeat comes before the deadline and no sooner than `heartbeatMs` after its request; test the exact interval after the last message in your core, with a clock that the test controls. Run it in the tests of a new core or a new surface. To read the result in code or as an agent, give `--output json` to `check` or `conform`: the report is one JSON document on standard output, with the same exit code. Do not read the text of the human output. For an application, test the capabilities through a session, and each surface through its own clients.

## Common mistakes

- A JSON catalog that has a source, changed by hand, so that the source no longer writes it.
- A schema that is `true` or `false`. Each input, output, failure, state, payload and type in `$defs` is a JSON object, and `acid-cat check` rejects a boolean schema there. Write `{}` for any value and `{ "not": {} }` for no value. A boolean inside a schema, such as `"additionalProperties": false`, is allowed.
- An `x-mcp-header` under `items`, `anyOf`, `allOf` or a `$ref`, on a `number` property, or with a value that is not an HTTP token. MCP clients through HTTP drop that tool or event, and `acid-cat check` rejects it ([surfaces](references/surfaces.md)).
- An event payload that is a string or an array. Wrap it in an object, so that it can get new members.
- A capability for agents with no `failures`: the agent cannot tell "the unit is offline" from a defect.
- A number schema with no limits for a value that has limits. The agent sends values that the operation cannot use.
- An input with a user id. Use the session instead.
- A TLS proxy written in front of the server of a core, or `serve` from `@acid-cat/cli` used to serve an application. End TLS in the platform, and serve with the server of the core.
- A server in a container that listens on `127.0.0.1`. Set `hostname` to `0.0.0.0`.
- Writing to standard output from a capability that an MCP server through stdio serves. Standard output carries only MCP messages.
- A long operation with no cancellation. Each core cancels the call when the client goes away. Stop the work when the signal (core-ts) or the fiber (core-effect) is cancelled. In core-rust, the core drops the future: release resources in `Drop`.
