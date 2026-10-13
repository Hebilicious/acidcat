<div align="center">

# 🐱 AcidCat

**One catalog. Every surface.**

Describe what your application can do one time. Serve it to your app, your command line, your agents and your APIs.

![Specification](https://img.shields.io/badge/spec-0.1_draft-ff69b4)
![JSON Schema](https://img.shields.io/badge/JSON_Schema-2020--12-0a7bbb)
![MCP](https://img.shields.io/badge/MCP-2026--07--28-111111)
![Effect](https://img.shields.io/badge/built_with-Effect-000000)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Python](https://img.shields.io/badge/Python-3776AB?logo=python&logoColor=white)
![Go](https://img.shields.io/badge/Go-00ADD8?logo=go&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-B7410E?logo=rust&logoColor=white)
![Pkl](https://img.shields.io/badge/Pkl-6B9543)
![Moon](https://img.shields.io/badge/monorepo-moon-6E56CF)

</div>

---

## ✨ What is AcidCat?

**AcidCat** (Application Capability IDentification Category) is a specification. An application writes one **catalog**: a JSON document that lists its capabilities, their inputs, outputs and failures, and the **targets** that can use each one. Each surface comes from the catalog through a **binding**:

| Surface | `aircon.temperature.set` becomes |
| --- | --- |
| 💻 Command line | `aircon temperature set --celsius 22` |
| 🤖 MCP server | the tool `aircon.temperature.set` |
| 🌐 WebMCP | an in-page tool for browser agents |
| 🔌 HTTP | `POST /capabilities/aircon.temperature.set` |
| 🧬 GraphQL | `mutation { airconTemperatureSet(input: { celsius: 22 }) }` |
| 🧩 TypeScript | a typed handle: `execute({ celsius: 22 })` |

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
| [Bindings](spec/bindings/README.md) | TypeScript, WebMCP, MCP, CLI, HTTP, GraphQL |
| [Extensions](spec/extensions/README.md) | Attachments, pagination |
| [Conformance](spec/conformance.md) | How to test a catalog and an implementation |

## 📦 Packages

| Package | Use |
| --- | --- |
| [`@acid-cat/core-effect`](packages/core-effect) | ⚡ Serve capabilities, written fully in Effect |
| [`@acid-cat/core-ts`](packages/core-ts) | 🟦 Serve capabilities in plain TypeScript, with no Effect dependency |
| [`@acid-cat/spec`](packages/spec) | 📐 The fixed details of the specification, as data |
| [`@acid-cat/cli`](packages/cli) | 🛠️ `acid-cat check`, `format` and `view` |
| [`@acid-cat/catalog`](packages/catalog/typescript) | ✍️ Write a catalog in TypeScript |
| [`acid-cat-catalog`](packages/catalog/python) | 🐍 Write a catalog in Python |
| [`acid-cat.dev/catalog`](packages/catalog/go) | 🐹 Write a catalog in Go |
| [`acid-cat-catalog`](packages/catalog/rust) | 🦀 Write a catalog in Rust |
| [`Catalog.pkl`](packages/catalog/pkl/Catalog.pkl) | 🧾 Write a catalog in Pkl |

## 🗺️ Roadmap

- [x] `@acid-cat/spec`: the fixed details of the specification as data, with no dependencies
- [x] `@acid-cat/core-effect`: serve capabilities, written fully in Effect
- [x] `@acid-cat/core-ts`: serve capabilities in plain TypeScript, with no Effect dependency
- [ ] `acid-cat conform`: test a running implementation through each binding

See [packages/README.md](packages/README.md).

## 🛠️ Development

[proto](https://moonrepo.dev/proto) installs the tools in `.prototools`: Moon, Node, pnpm, Pkl, Python, Go and Rust. [Moon](https://moonrepo.dev) runs the tasks.

```sh
proto install
pnpm install
moon run verify
```

| Command | Use |
| --- | --- |
| `moon run examples` | Write the example catalogs from Pkl, in canonical form |
| `moon run check` | Check the examples and the test files |
| `moon run :test` | Test all packages |
| `moon run verify` | Do all checks and tests |
| `pnpm exec acid-cat …` | Run the command line |
