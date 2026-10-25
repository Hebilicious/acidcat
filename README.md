<div align="center">

# 🐱 AcidCat

**One catalog. Every surface.**

A language-neutral specification. Describe what your application can do one time. Serve it to your app, your command line, your agents and your APIs, in any language.

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
> **AcidCat is experimental and a work in progress.** The specification is a draft. The packages have versions `0.x`, and each minor version can break their APIs. Pin exact versions.

---

## ✨ What is AcidCat?

**AcidCat** (Application Capability IDentification Category) is a specification. It does not depend on a language or a library. An application writes one **catalog**: a JSON document that lists its capabilities, their inputs, outputs and failures, and the **targets** that can use each one. Each surface comes from the catalog through a **binding**:

| Surface | `aircon.temperature.set` becomes |
| --- | --- |
| 💻 Command line | `aircon temperature set --celsius 22` |
| 🤖 MCP server | the tool `aircon.temperature.set` |
| 🌐 WebMCP | an in-page tool for browser agents |
| 🔌 HTTP | `POST /capabilities/aircon.temperature.set` |
| 🧩 Your language | a typed function, for example `execute({ celsius: 22 })` in TypeScript |

The catalog is checked at build time. Programs do not read it at run time.

## 🧭 How it works

```
                         catalog
          (one document: what the application can do)
                            │
          ┌─────────────────┼──────────────────┐
      provider          bindings            clients
   (does the        (rules that make     (web, mobile,
   operations)       one kind of          desktop, cli,
                     surface)             mcp, api, …)
```

## 🌬️ Example

An air conditioner, written in Pkl ([full example](examples/aircon.pkl)):

```pkl
amends "../packages/catalog/pkl/Catalog.pkl"

targets {
  ["app"] { bindings { "typescript" } }
  ["mcp"] { bindings { "mcp" } }
}

capabilities {
  ["aircon.temperature.set"] {
    description = "Set the target temperature in degrees Celsius."
    audience { "app"; "mcp" }
    input {
      type = "object"
      required { "celsius" }
      properties { ["celsius"] { type = "number"; minimum = 16; maximum = 31 } }
    }
    failures { ["Offline"] { type = "object" } }
  }
}
```

The same catalog in [TypeScript](packages/catalog/typescript/examples/aircon.ts), [Python](packages/catalog/python/examples/aircon.py), [Go](packages/catalog/go/examples/aircon/aircon.go) or [Rust](packages/catalog/rust/examples/aircon.rs) gives the same bytes: [`aircon.acidcat.json`](examples/aircon.acidcat.json).

## 📚 Specification

| Document | Contents |
| --- | --- |
| [Overview and vocabulary](spec/README.md) | The terms and the documents |
| [Catalog](spec/catalog.md) | Targets, capabilities, types, views, canonical form |
| [Invocation](spec/invocation.md) | Outcomes, availability, sessions, cancellation |
| [Bindings](spec/bindings/README.md) | TypeScript, WebMCP, MCP, CLI, HTTP |
| [Extensions](spec/extensions/README.md) | Attachments, pagination |
| [Conformance](spec/conformance.md) | How to test a catalog and an implementation |

## 📦 Packages

### Tools for all implementations

These tools work with an implementation in any language.

| Package | Use |
| --- | --- |
| [`@acid-cat/cli`](packages/cli) | 🛠️ `acid-cat check`, `format` and `view` for catalogs. `acid-cat conform` tests a running implementation through its bindings |
| [`@acid-cat/catalog`](packages/catalog/typescript) | ✍️ Write a catalog in TypeScript |
| [`acid-cat-catalog`](packages/catalog/python) | 🐍 Write a catalog in Python |
| [`github.com/Hebilicious/acidcat/packages/catalog/go`](packages/catalog/go) | 🐹 Write a catalog in Go |
| [`acid-cat-catalog`](packages/catalog/rust) | 🦀 Write a catalog in Rust |
| [`Catalog.pkl`](packages/catalog/pkl/Catalog.pkl) | 🧾 Write a catalog in Pkl |

### Reference implementation in TypeScript

These packages show one way to implement the specification. They serve the TypeScript binding and the MCP, WebMCP, CLI and HTTP bindings, and they pass all checks of `acid-cat conform`. The specification does not depend on them.

| Package | Use |
| --- | --- |
| [`@acid-cat/spec-ts`](packages/spec-ts) | 📐 The fixed details of the specification, as TypeScript data and functions |
| [`@acid-cat/core-effect`](packages/core-effect) | ⚡ Serve capabilities, written fully in Effect |
| [`@acid-cat/core-ts`](packages/core-ts) | 🟦 Serve capabilities in plain TypeScript, with no Effect dependency |

Reference implementations in more languages will follow. You do not need a package from this repository to implement AcidCat. A program that serves the bindings as the specification tells is an implementation. You, or an agent, can write a core for your language from [the specification](spec/README.md), and test it with `acid-cat conform`.

To build your own API, for example in GraphQL, see [`examples/apis`](examples/apis/README.md): GraphQL, Cap'n Web and Elysia APIs, each beside the HTTP binding, and an MCP server in Effect beside the MCP binding.

## 🗺️ Roadmap

- [x] `acid-cat conform`: test a running implementation through each binding
- [x] A reference implementation in TypeScript: `@acid-cat/spec-ts`, `@acid-cat/core-effect` and `@acid-cat/core-ts`
- [ ] Reference implementations in more languages
- [ ] A site that publishes the specification

See [packages/README.md](packages/README.md).

## 🛠️ Development

[proto](https://moonrepo.dev/proto) installs the tools in `.prototools`: Moon, Node, pnpm, Pkl, Python, Go and Rust. [Moon](https://moonrepo.dev) runs the tasks.

```sh
proto install
pnpm install
moon run verify
```

CI runs `moon run verify` on each push to `main` and on each pull request. Changes go into `main` only through a pull request, with a squash merge. The `semantic` check requires the pull request title and each commit title to have the form `type(scope): subject`, for example `fix(catalog): reject duplicate ids`.

| Command | Use |
| --- | --- |
| `moon run examples` | Render every Pkl catalog, and write every catalog of the repository in canonical form |
| `moon run check` | Check that every catalog of the repository is rendered, canonical and conforms |
| `moon run :test` | Test all packages |
| `moon run verify` | Do all checks and tests |
| `pnpm exec acid-cat …` | Run the command line |
| `moon run :build` | Build the npm packages into `dist/` |
| `moon run packages` | Install the packed npm packages into an empty project, and test them |

To publish the packages, see [Publishing](packages/README.md#publishing).
