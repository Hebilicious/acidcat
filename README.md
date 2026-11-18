<div align="center">

# 🐱 AcidCat

**Describe what your application can do once. Serve it as a CLI, an MCP server, an HTTP API and typed client code.**

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

An application has many front doors: its UI, a command line, an MCP server for AI agents, an HTTP API. Each one usually reimplements the same operations with its own names, validation and errors, and they drift apart.

AcidCat lists those operations once, in a **catalog**. Every surface comes from it, so every surface takes the same input, returns the same failures and shows each client only what it is allowed to use.

| Surface | The capability `aircon.power.set` becomes |
| --- | --- |
| 💻 Command line | `home aircon power set --on` |
| 🤖 MCP server | the tool `aircon.power.set` |
| 🌐 WebMCP | a tool that a browser agent calls in your web page, as the signed-in user |
| 🔌 HTTP | `POST /capabilities/aircon.power.set` |
| 🧩 Your language | a typed function, for example `execute({ on: true })` in TypeScript |

## 🌬️ Example

### 1. Write the catalog

Write the catalog in your own language: the capabilities, their schemas and their targets. With the TypeScript core and Zod:

```ts
import { cliMain, defineApp, defineCapability, fail, ok, renderCatalog } from "@acid-cat/core-ts";
import type { ToJsonSchema } from "@acid-cat/core-ts";
import { z } from "zod";

const unit = { online: true, on: false };

const powerSet = defineCapability({
  id: "aircon.power.set",
  description: "Turn the unit on or off.",
  audience: ["cli", "mcp"],
  destructive: true,
  idempotent: true,
  input: z.object({ on: z.boolean() }),
  failures: { Offline: z.object({ _tag: z.literal("Offline") }) },
  run: ({ on }) => {
    if (!unit.online) return fail({ _tag: "Offline" });
    unit.on = on;
    return ok(null);
  },
});

const aircon = defineApp({
  title: "Air conditioner",
  targets: { cli: { bindings: ["cli"] }, mcp: { bindings: ["mcp"] } },
  capabilities: [powerSet],
});

const toJsonSchema: ToJsonSchema = (schema) => {
  if (!(schema instanceof z.ZodType)) throw new Error("Only Zod schemas.");
  return z.toJSONSchema(schema, { target: "draft-2020-12" });
};
```

`renderCatalog(aircon, { toJsonSchema })` writes the catalog as JSON. Commit it, and run `acid-cat check` on it in CI.

### 2. Serve it

```ts
cliMain(aircon, { name: "home", version: "0.1.0", context: {}, toJsonSchema });
```

```sh
$ node aircon.ts aircon power set --on
null
```

Pass the same `aircon` to `mcpStdioMain` for an MCP server, or to `httpHandler` for an HTTP API. MCP clients get `destructiveHint` and `idempotentHint`, so an agent knows to ask before it turns the unit off.

## 🧭 How it works

| Part | What it is |
| --- | --- |
| Catalog | The contract, stored as JSON. Write it in a core's code, or, when several programs share it, in [Pkl](packages/catalog/pkl) or with a [catalog library](packages/catalog). Checked at build time; programs do not read it at run time |
| Binding | The rules for one surface: CLI, MCP, HTTP, WebMCP or a language such as TypeScript. Defined in the [specification](spec/bindings/README.md) |
| Core | A library that runs your capabilities and serves the bindings |
| `acid-cat conform` | Tests a running program from the outside, through each binding |

## 🧳 Features

- Each target sees only its own capabilities. A capability that writes a local file can belong to the `cli` target alone ([example](examples/aircon/README.md#command-line-only)).
- Failures are typed data, declared by tag. An unexpected error becomes the call failure `internal`, and its details stay on the server.
- Events, such as `aircon.status.changed`, stream occurrences to subscribers over the CLI, MCP, HTTP (server-sent events) and TypeScript ([events](spec/events.md)).
- WebMCP lets a browser agent call your page's capabilities directly, with the user's session ([binding](spec/bindings/webmcp.md)).
- The command line has aliases such as `aircon --on`, JSON or human output, and Ctrl+C cancellation ([binding](spec/bindings/cli.md)).
- For an API you design yourself, such as GraphQL, call the same capabilities through a session ([examples](examples/aircon/README.md#apis)).

## 📚 Specification

AcidCat is a specification first. The packages here are one implementation of it.

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

| Package | Use |
| --- | --- |
| [`@acid-cat/cli`](packages/cli) | 🛠️ `acid-cat check`, `format`, `view` and `conform` |
| [`@acid-cat/core-ts`](packages/core-ts) | 🟦 Core in plain TypeScript, with any Standard Schema library |
| [`@acid-cat/core-effect`](packages/core-effect) | ⚡ Core in Effect, with Effect Schema |
| [`acid-cat-core`](packages/core-rust) | 🦀 Core in Rust, on Tokio. No WebMCP |
| [Catalog libraries](packages/catalog) | ✍️ Write a catalog in TypeScript, Python, Go, Rust or Pkl |

You do not need these packages: any program that follows the [specification](spec/README.md) and passes `acid-cat conform` is an implementation. [packages/README.md](packages/README.md) lists every package and compares the cores.

## 🤖 Agent skill

[`skills/acid-cat`](skills/acid-cat/SKILL.md) teaches coding agents to build with AcidCat:

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

[proto](https://moonrepo.dev/proto) installs the tools in `.prototools`, and [Moon](https://moonrepo.dev) runs the tasks:

```sh
proto install
pnpm install
moon run verify   # every check and test, as in CI
```

| Command | Use |
| --- | --- |
| `moon run :test` | Test all packages |
| `moon run lint` | Lint all TypeScript |
| `moon run examples` | Write every catalog in canonical form |
| `moon run model:generate` | Write the cases of the [formal model](model/README.md) into each core |

Pull requests are squash-merged, with titles like `fix(catalog): reject duplicate ids`. Releases: see [Publishing](packages/README.md#publishing).
