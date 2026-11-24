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

AcidCat stands for **A**pplication **C**apability **Id**entification **Cat**alog.

> [!WARNING]
> AcidCat is experimental. The specification is a draft, and the packages are `0.x`: any minor release can break their APIs. Pin exact versions.

## ✨ Why AcidCat

An application has many front doors: its UI, a command line, an MCP server for AI agents, an HTTP API. Each one usually reimplements the same operations with its own names, validation and errors, and they drift apart.

AcidCat lists those operations once, in a **catalog**, and serves that one catalog through many **surfaces**. Every surface takes the same input, returns the same failures and shows each client only what it is allowed to use.

| Surface | The capability `aircon.power.set` becomes |
| --- | --- |
| 💻 Command line | `home aircon power set --on` |
| 🤖 MCP server | the tool `aircon.power.set` |
| 🌐 WebMCP | a tool that a browser agent calls in your web page, as the signed-in user |
| 🔌 HTTP | `POST /capabilities/aircon.power.set` |
| 🧩 Your language | a handle, for example `execute({ on: true })` in TypeScript, or `session.invoke("aircon.power.set", input, &cancel)` in Rust |

## 🌬️ Example

### 1. Write the catalog

Declare each capability in code: its schemas, its targets and the function that runs it. These declarations are the catalog. With the TypeScript core and Zod:

```ts
// aircon.ts
import { defineApp, defineCapability, fail, ok } from "@acid-cat/core-ts";
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

export const aircon = defineApp({
  title: "Air conditioner",
  targets: { cli: { surfaces: ["cli"] }, mcp: { surfaces: ["mcp"] } },
  capabilities: [powerSet],
});

export const toJsonSchema: ToJsonSchema = (schema) => {
  if (!(schema instanceof z.ZodType)) throw new Error("Only Zod schemas.");
  return z.toJSONSchema(schema, { target: "draft-2020-12" });
};
```

At build time, write the catalog as JSON and check it:

```ts
// catalog.ts
import { writeFile } from "node:fs/promises";
import { renderCatalog } from "@acid-cat/core-ts";
import { aircon, toJsonSchema } from "./aircon.ts";

await writeFile("aircon.acidcat.json", renderCatalog(aircon, { toJsonSchema }));
```

```sh
node catalog.ts
acid-cat check aircon.acidcat.json
```

### 2. Serve it

```ts
// cli.ts
import { cliMain } from "@acid-cat/core-ts";
import { aircon, toJsonSchema } from "./aircon.ts";

cliMain(aircon, { name: "home", version: "0.1.0", context: {}, toJsonSchema });
```

```sh
$ node cli.ts aircon power set --on
null
```

Pass the same `aircon` to `mcpStdioMain` for an MCP server, or to `httpHandler` for an HTTP API. MCP clients get `destructiveHint` and `idempotentHint`, so an agent knows to ask before it turns the unit off.

## 🧭 How it works

| Part | What it is |
| --- | --- |
| Catalog | The contract, stored as JSON. Write it in the typed language of your choice: a core's code, a [catalog library](packages/catalog) for TypeScript, Python, Go or Rust, or [Pkl](packages/catalog/pkl). Checked at build time; programs do not read it at run time |
| Target | A group of clients, and what they can use, for example `cli` or `mcp`. The catalog lists the surfaces of each target. Each target sees only the part of the catalog that it can use, the catalog of the target |
| Surface | One way for clients to reach a target: MCP, WebMCP, the CLI, HTTP, or a language such as TypeScript or Rust. Defined in the [specification](spec/surfaces/README.md). Each language surface maps one contract with no language, the [programmatic surface](spec/surfaces/programmatic.md). The [vocabulary](spec/README.md#vocabulary) defines each term |
| Core | A library that runs your capabilities and serves the surfaces of each target |
| `acid-cat conform` | Tests a running program from the outside, through each protocol surface. The tests of each core test its language surface |

## 🧳 Features

- Each target sees only its own capabilities. A capability that writes a local file can belong to the `cli` target alone ([example](examples/aircon/README.md#command-line-only)).
- Failures are typed data, declared by tag. An unexpected error becomes the call failure `internal`, and its details stay on the server.
- Events, such as `aircon.status.changed`, stream occurrences to subscribers over the CLI, MCP, HTTP (server-sent events), TypeScript and Rust ([events](spec/events.md)). Through MCP, the events follow the Final text of the [MCP events extension](spec/surfaces/mcp.md#events), SEP-3415: push, poll and webhook delivery, and a heartbeat interval that the client suggests and the server grants.
- Through MCP over HTTP, an input property with `x-mcp-header` is mirrored into an `Mcp-Param-*` header, for a tool and for an event. Each server checks the `Mcp-Method`, `Mcp-Name` and `Mcp-Param-*` headers against the body, so a load balancer can route on them safely ([headers](spec/surfaces/mcp.md#headers)). `acid-cat check` rejects an `x-mcp-header` that the MCP transport forbids ([header annotations](spec/surfaces/mcp.md#header-annotations)).
- Through MCP over HTTP, each server publishes an MCP [Server Card](spec/surfaces/mcp.md#server-card) at `<MCP URL>/server-card`, so that a client can find how to connect before it connects. The card is on by default, with a name from the host and the name of the server (`com.example.aircon/aircon` for `aircon.example.com`) and the description of the catalog. The deployment can give its own name, description and URL, or turn the card off. In core-effect, `Mcp.withEvents` serves a card for your own MCP server too, with the version of its `server/discover`. A server with webhook delivery can also sign each delivery with Ed25519 keys (`v1a,` signatures beside the `v1,` HMAC), and the card gives the public keys and the egress IP ranges of the server, so that a gateway can check which server sent a delivery. Signing keys and egress ranges need the card, so a server with them and the card off fails when it starts.
- WebMCP lets a browser agent call your page's capabilities directly, with the user's session ([surface](spec/surfaces/webmcp.md)).
- The command line has aliases such as `home --on`, JSON or human output, and Ctrl+C cancellation. In a pipe, it writes each result as one line of JSON, so an agent or a script reads less text ([surface](spec/surfaces/cli.md)).
- In code, a session gives a handle for each capability and an event handle for each event. The [programmatic surface](spec/surfaces/programmatic.md) gives the rules of handles, outcomes, availability, state, cancellation and events for every language. The [TypeScript](spec/surfaces/typescript.md) and [Rust](spec/surfaces/rust.md) surfaces map it to their language.
- For an API you design yourself, such as GraphQL, call the same capabilities through a session ([examples](examples/aircon/README.md#apis)).

## 📚 Specification

AcidCat is a specification first. The packages here are one implementation of it.

| Document | Contents |
| --- | --- |
| [Overview and vocabulary](spec/README.md) | The terms used in every document |
| [Catalog](spec/catalog.md) | Targets, capabilities, events, types, the catalog of a target, canonical form |
| [Invocation](spec/invocation.md) | Outcomes, availability, sessions, cancellation |
| [Events](spec/events.md) | Subscriptions, occurrences, resuming |
| [Surfaces](spec/surfaces/README.md) | The programmatic surface and its TypeScript and Rust mappings, WebMCP, MCP, CLI, HTTP |
| [Extensions](spec/extensions/README.md) | Attachments, pagination |
| [Conformance](spec/conformance.md) | How to test a catalog and an implementation |

## 📦 Packages

| Package | Use |
| --- | --- |
| [`@acid-cat/cli`](packages/cli) | 🛠️ `acid-cat check`, `format`, `target` and `conform` |
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

- [x] `acid-cat conform`: test a running implementation through each protocol surface
- [x] Cores in TypeScript: `@acid-cat/core-ts` and `@acid-cat/core-effect`
- [x] A core in Rust: `acid-cat-core`
- [ ] Cores in more languages
- [x] A site that publishes the documentation, the examples, the specification and the list of packages: [acidcat.hebilicious.workers.dev](https://acidcat.hebilicious.workers.dev), from [`site/`](site/README.md). Each page of [Examples](https://acidcat.hebilicious.workers.dev/docs/examples/) has a code explorer that reads the files of [`examples/`](examples/aircon/README.md) when the site is built. The site serves its own content to agents through AcidCat: an MCP server at `/mcp`, an HTTP API at `/api`, WebMCP tools in each page, each page as Markdown, `llms.txt`, and the `acid-cat` skill at `/.well-known/agent-skills/index.json`

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
| `moon run lint` | Lint all TypeScript, and check that all Rust has the format of `cargo fmt` |
| `moon run examples` | Write every catalog in canonical form |
| `moon run model:generate` | Write the cases of the [formal model](model/README.md) into each core |
| `moon run site:dev` | Serve the [site](site/README.md): the homepage, the documentation, the examples, the specification and the packages |

Pull requests are squash-merged, with titles like `fix(catalog): reject duplicate ids`. Releases: see [Publishing](packages/README.md#publishing).
