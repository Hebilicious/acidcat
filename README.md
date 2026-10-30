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
![Kotlin](https://img.shields.io/badge/Kotlin-7F52FF?logo=kotlin&logoColor=white)
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

On the command line, each input property is a flag. An array of simple values takes one flag for each item, `aircon schedule set --days mon --days fri --hours 7`, or the whole array as JSON text, `--days '["mon","fri"]'`.

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

An air conditioner, written in Pkl ([full example](examples/aircon/catalog/aircon.pkl)):

```pkl
amends "../../../packages/catalog/pkl/Catalog.pkl"

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

The best way to write a catalog is in Pkl, with a catalog library, or from the code of the application. A tool then writes the JSON, in [canonical form](spec/catalog.md#canonical-form). JSON written by hand is also a catalog, if it conforms. The same catalog in [TypeScript](examples/aircon/catalog/typescript.ts), [Python](examples/aircon/catalog/python.py), [Go](examples/aircon/catalog/go/main.go) or [Rust](examples/aircon/catalog/rust/src/main.rs) gives the same bytes: [`aircon.acidcat.json`](examples/aircon/catalog/aircon.acidcat.json). [`examples/aircon`](examples/aircon/README.md) also serves the air conditioner with both TypeScript cores, as a command line, and through APIs.

## 📚 Specification

| Document | Contents |
| --- | --- |
| [Overview and vocabulary](spec/README.md) | The terms and the documents |
| [Catalog](spec/catalog.md) | Targets, capabilities, types, views, canonical form |
| [Invocation](spec/invocation.md) | Outcomes, availability, sessions, cancellation |
| [Bindings](spec/bindings/README.md) | TypeScript, Kotlin, WebMCP, MCP, CLI, HTTP |
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

### Reference implementation in Kotlin

These packages show the same specification on the JVM and on Android. They serve the Kotlin binding and the MCP, CLI and HTTP bindings, and they pass all checks of `acid-cat conform` for these bindings.

| Package | Use |
| --- | --- |
| [`dev.acidcat:acid-cat-core-kotlin`](packages/core-kotlin) | 🟪 Serve capabilities in Kotlin, with coroutines and kotlinx.serialization |
| [`dev.acidcat:acid-cat-ktor`](packages/core-kotlin) | 🌐 Serve the MCP and HTTP bindings with Ktor |

Reference implementations in more languages will follow. You do not need a package from this repository to implement AcidCat. A program that serves the bindings as the specification tells is an implementation. You, or an agent, can write a core for your language from [the specification](spec/README.md), and test it with `acid-cat conform`.

To build your own API, for example in GraphQL, see [the APIs of the air conditioner](examples/aircon/README.md#apis): GraphQL, Cap'n Web and Elysia APIs, each beside the HTTP binding, and an MCP server in Effect beside the MCP binding.

## 🗺️ Roadmap

- [x] `acid-cat conform`: test a running implementation through each binding
- [x] A reference implementation in TypeScript: `@acid-cat/spec-ts`, `@acid-cat/core-effect` and `@acid-cat/core-ts`
- [x] A reference implementation in Kotlin: `acid-cat-core-kotlin` and `acid-cat-ktor`
- [ ] Publish the Kotlin packages to Maven Central
- [ ] Reference implementations in more languages
- [ ] A site that publishes the specification

See [packages/README.md](packages/README.md).

## 🛠️ Development

[proto](https://moonrepo.dev/proto) installs the tools in `.prototools`: Moon, Node, pnpm, Pkl, Python, Go, Rust, Java and Gradle. [Moon](https://moonrepo.dev) runs the tasks.

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
| `moon run lint` | Lint all TypeScript with type information, and check that no code turns the type checks off |
| `moon run :test` | Test all packages |
| `moon run verify` | Do all checks and tests |
| `pnpm exec acid-cat …` | Run the command line |
| `moon run :build` | Build the npm packages into `dist/` |
| `moon run packages` | Install the packed npm packages into an empty project, and test them |

To publish the packages, see [Publishing](packages/README.md#publishing).
