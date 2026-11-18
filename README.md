<div align="center">

# 🐱 AcidCat

**Describe your application's operations once. Get a CLI, an MCP server, an HTTP API and typed client code from that one description.**

[![CI](https://github.com/Hebilicious/acidcat/actions/workflows/ci.yml/badge.svg)](https://github.com/Hebilicious/acidcat/actions/workflows/ci.yml)
![Specification](https://img.shields.io/badge/spec-0.1_draft-ff69b4)
![JSON Schema](https://img.shields.io/badge/JSON_Schema-2020--12-0a7bbb)
![MCP](https://img.shields.io/badge/MCP-2026--07--28-111111)
[![npm](https://img.shields.io/npm/v/@acid-cat/cli?label=%40acid-cat%2Fcli)](https://www.npmjs.com/package/@acid-cat/cli)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Python](https://img.shields.io/badge/Python-3776AB?logo=python&logoColor=white)
![Go](https://img.shields.io/badge/Go-00ADD8?logo=go&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-B7410E?logo=rust&logoColor=white)
![Pkl](https://img.shields.io/badge/Pkl-6B9543)
![Moon](https://img.shields.io/badge/monorepo-moon-6E56CF)

</div>

> [!WARNING]
> AcidCat is experimental. The specification is a draft, and the packages are `0.x`: any minor release can break their APIs. Pin exact versions.

## ✨ Why AcidCat

An application today has many front doors. People use a web or mobile app. Developers want a command line. AI agents want an MCP server, or tools in the web page they are looking at. Other services want an HTTP API.

Each of these usually gets its own code for the same operation, such as "set the temperature". Each copy has its own names, its own input validation and its own error format, and the copies drift apart. When you add an operation, you add it four times, or you forget one.

AcidCat replaces those copies with one description, the **catalog**. The catalog lists every operation (a **capability**), its input and output as JSON Schema, the failures it can return, and which clients may use it. A **core** library runs your code behind the catalog and serves each surface from it:

| Surface | The capability `aircon.temperature.set` becomes |
| --- | --- |
| 💻 Command line | `aircon temperature set --celsius 22` |
| 🤖 MCP server | the tool `aircon.temperature.set` |
| 🌐 WebMCP | a tool that a browser agent calls inside your web page, as the signed-in user |
| 🔌 HTTP | `POST /capabilities/aircon.temperature.set` |
| 🧩 Your language | a typed function, for example `execute({ celsius: 22 })` in TypeScript |

Every surface validates input against the same schemas and returns the same failures, and each one exposes only the operations its target may use. `acid-cat conform` tests every surface against the specification, so you can check that this holds.

Applications can also publish **events** that clients follow, such as `aircon.status.changed`. The command line prints one JSON line per occurrence, MCP clients get them through the MCP events extension, HTTP clients get a server-sent events stream, and TypeScript code gets an async handle.

## 🧭 How it works

```
                 catalog (JSON)
     what the application can do, and for whom
                       │
        ┌──────────────┼───────────────┐
      core          bindings         clients
  runs your code   rules for each   CLI, MCP, HTTP,
                   surface          WebMCP, your app
```

1. **Write the catalog.** Write it in [Pkl](packages/catalog/pkl), with a catalog library in TypeScript, Python, Go or Rust, or let a core generate it from your code. Every tool writes the same JSON, in one [canonical form](spec/catalog.md#canonical-form).
2. **Implement the capabilities** with a core. A capability is a function that takes the validated input and returns a value or a declared failure.
3. **Serve the surfaces.** The core turns each target's slice of the catalog (its **view**) into a CLI, an MCP server, an HTTP API or WebMCP tools. The rules for each surface are a **binding**, defined in the [specification](spec/bindings/README.md).
4. **Test.** `acid-cat check` validates the catalog. `acid-cat conform` connects to your running program through each binding and checks it from the outside.

The catalog is checked at build time. Programs do not read it at run time.

## 🌬️ Example

Here is a capability in the TypeScript core, with Zod for the schemas:

```ts
import { capabilitiesFor, defineApp, fail, ok } from "@acid-cat/core-ts";
import { z } from "zod";

const Offline = z.object({ _tag: z.literal("Offline") });
const capability = capabilitiesFor<{ unit: Unit }>();

export const aircon = defineApp<{ unit: Unit }>({
  title: "Living-room air conditioner",
  targets: { cli: { bindings: ["cli"] }, mcp: { bindings: ["mcp"] } },
  capabilities: [
    capability({
      id: "aircon.power.set",
      description: "Turn the unit on or off.",
      audience: ["cli", "mcp"],
      destructive: true,
      idempotent: true,
      input: z.object({ on: z.boolean() }),
      failures: { Offline },
      run: async ({ on }, { context, signal }) => ((await context.unit.setPower(on, signal)) ? ok(null) : fail({ _tag: "Offline" })),
    }),
  ],
});
```

Two one-line programs serve the same `aircon` object, one as a command line and one as an MCP server over stdio:

```ts
import { cliMain, mcpStdioMain } from "@acid-cat/core-ts";

cliMain(aircon, { name: "aircon", version: "0.1.0", context: { unit }, toJsonSchema });     // aircon aircon power set --on
mcpStdioMain(aircon, { name: "aircon", version: "0.1.0", context: { unit }, toJsonSchema }); // tool aircon.power.set
```

The MCP server reports the hints as `destructiveHint` and `idempotentHint`, so an agent can ask the user before it turns the unit off.

[`examples/aircon`](examples/aircon/README.md) is the full application. It writes the same catalog from Pkl, TypeScript, Python, Go and Rust, byte for byte ([`aircon.acidcat.json`](examples/aircon/catalog/aircon.acidcat.json)). It then serves it with each core as a command line, an MCP server, a web page with WebMCP tools and an HTTP API, next to hand-written GraphQL, Cap'n Web and Elysia APIs.

## 🧳 Features

- Each capability and event lists the targets that can use it, so an agent sees only what you give it. A capability that only makes sense in one place, such as writing a local file, can be given to the `cli` target alone ([example](examples/aircon/README.md#command-line-only)).
- The hints `readOnly`, `destructive` and `idempotent` tell clients what a call does, so an agent knows when to ask before it acts. MCP clients get them as tool annotations ([catalog](spec/catalog.md#capabilities)).
- A capability declares its failures by tag, for example `Offline`. Clients get a typed failure, not an exception. An unexpected error becomes the call failure `internal`, and its details stay on the server ([invocation](spec/invocation.md)).
- A session holds the client's identity, so inputs never carry credentials. A capability can be unavailable with a reason, and every call can be cancelled ([invocation](spec/invocation.md)).
- With WebMCP, a browser agent calls your page's capabilities directly, with the user's session and state, instead of reading the screen and clicking buttons. `installWebMcp(session)` in core-ts and `WebMcp.install` in core-effect add the tools. The page works as before in a browser without WebMCP ([binding](spec/bindings/webmcp.md), [example](examples/aircon/README.md#webmcp)).
- On the command line, each input property becomes a flag, and arrays take repeated flags. The catalog can declare short aliases such as `aircon --on` or `aircon fan high`, and a default command. Output is JSON for scripts and agents, with an optional human format for terminals. Ctrl+C cancels the call and exits with code 130 ([binding](spec/bindings/cli.md)).
- Bindings cover the common surfaces. For a GraphQL or RPC API that you design yourself, call the same capabilities through a session. [`examples/aircon/apis`](examples/aircon/README.md#apis) shows GraphQL, Cap'n Web and Elysia APIs, and an MCP server written by hand in Effect.

## 📚 Specification

AcidCat is a specification first. The packages in this repository are one implementation of it.

| Document | Contents |
| --- | --- |
| [Overview and vocabulary](spec/README.md) | The terms used in every document |
| [Catalog](spec/catalog.md) | Targets, capabilities, events, types, views, canonical form |
| [Invocation](spec/invocation.md) | Outcomes, availability, sessions, cancellation |
| [Events](spec/events.md) | Subscriptions, occurrences, resuming |
| [Bindings](spec/bindings/README.md) | TypeScript, WebMCP, MCP, CLI, HTTP |
| [Extensions](spec/extensions/README.md) | Attachments, pagination |
| [Conformance](spec/conformance.md) | How to test a catalog and an implementation |

## 📦 Packages

**Tools for any language.** Use these with any implementation.

| Package | Use |
| --- | --- |
| [`@acid-cat/cli`](packages/cli) | 🛠️ `acid-cat check`, `format` and `view` for catalogs, and `acid-cat conform` to test a running implementation |
| [`Catalog.pkl`](packages/catalog/pkl) | 🧾 Write a catalog in Pkl |
| [`@acid-cat/catalog`](packages/catalog/typescript) | ✍️ Write a catalog in TypeScript |
| [`acid-cat-catalog`](packages/catalog/python) (PyPI) | 🐍 Write a catalog in Python |
| [`github.com/Hebilicious/acidcat/packages/catalog/go`](packages/catalog/go) | 🐹 Write a catalog in Go |
| [`acid-cat-catalog`](packages/catalog/rust) (crates.io) | 🦀 Write a catalog in Rust |

**Cores.** Each core runs capabilities and events and serves the bindings. All three pass every check of `acid-cat conform` for the bindings they serve.

| Package | Language and style | Bindings |
| --- | --- | --- |
| [`@acid-cat/core-ts`](packages/core-ts) | 🟦 Plain TypeScript. Capabilities return promises; schemas use any Standard Schema library | TypeScript, MCP, HTTP, CLI, WebMCP |
| [`@acid-cat/core-effect`](packages/core-effect) | ⚡ Effect. Capabilities are Effect programs; schemas use Effect Schema | TypeScript, MCP, HTTP, CLI, WebMCP |
| [`acid-cat-core`](packages/core-rust) | 🦀 Rust on Tokio. Schemas come from `serde` and `schemars` types | MCP, HTTP, CLI |

The Rust core has no WebMCP binding, because WebMCP runs in a web page. [`@acid-cat/spec-ts`](packages/spec-ts) holds the specification's fixed data for the TypeScript cores, and [`@acid-cat/mcp-handshake`](packages/mcp-handshake) serves MCP clients that use the older `initialize` handshake. [packages/README.md](packages/README.md) compares the cores and explains how releases work.

**Other languages.** You do not need a package from this repository. Any program that serves the bindings as the specification describes is an implementation. Write a core for your language from [the specification](spec/README.md), and test it with `acid-cat conform`.

## 🤖 Agent skill

[`skills/acid-cat`](skills/acid-cat/SKILL.md) teaches a coding agent to build with AcidCat: the catalog rules, how to choose a core, how to add a capability or an event, and how to test. Install it in a project:

```sh
gh skill install Hebilicious/acidcat acid-cat
```

## 🗺️ Roadmap

- [x] `acid-cat conform`: test a running implementation through each binding
- [x] Cores in TypeScript: `@acid-cat/core-ts` and `@acid-cat/core-effect`
- [x] A core in Rust: `acid-cat-core`
- [ ] Cores in more languages
- [ ] A site that publishes the specification

## 🛠️ Development

[proto](https://moonrepo.dev/proto) installs the tools pinned in `.prototools` (Moon, Node, pnpm, Pkl, Python, uv, Go, Rust, and Java for the Apalache model checker). [Moon](https://moonrepo.dev) runs the tasks.

```sh
proto install
pnpm install
moon run verify
```

| Command | Use |
| --- | --- |
| `moon run verify` | Run every check and test. CI runs this on each pull request and each push to `main` |
| `moon run :test` | Test all packages |
| `moon run lint` | Lint all TypeScript with type information, and check that no code turns type checks off |
| `moon run examples` | Render every Pkl catalog, and write every catalog in canonical form |
| `moon run check` | Check that every catalog is rendered, canonical and conforms |
| `moon run model:generate` | Write the data and test cases of the formal model into each core |
| `moon run :build` | Build the npm packages into `dist/` |
| `pnpm exec acid-cat …` | Run the AcidCat command line |

Rules that every core must follow the same way have a formal model in Quint, in [`model/`](model/README.md). `quint verify` proves its properties, and each core runs every case that the model generates.

Changes reach `main` only through squash-merged pull requests. Pull request and commit titles have the form `type(scope): subject`, for example `fix(catalog): reject duplicate ids`. The `semantic` check enforces this. To publish packages, see [Publishing](packages/README.md#publishing).
