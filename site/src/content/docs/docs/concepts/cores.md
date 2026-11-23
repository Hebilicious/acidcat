---
title: Cores
description: A core is a library that runs your capabilities and events, and serves the bindings. The repository has three cores, and any language can have one.
sidebar:
  order: 16
---

A **core** is a library that runs your capabilities and events, and serves the bindings. You declare the capabilities in code. The core validates each input, runs your function, and gives each outcome the form of each binding. It can also write the catalog from your code.

## The three cores

The repository has three cores. Each core has the same features, in its own style, and passes `acid-cat conform`.

| Core | Package | Style |
| --- | --- | --- |
| TypeScript | npm `@acid-cat/core-ts` | A capability is a function that returns a promise. Schemas use any Standard Schema library, for example Zod |
| Effect | npm `@acid-cat/core-effect` | A capability is an Effect program with Effect Schema. Sessions are scopes, and services are layers |
| Rust | crates.io `acid-cat-core` | A capability is an async function on Tokio. Schemas come from types that derive `serde` and `schemars::JsonSchema` |

The two TypeScript cores serve all five bindings. Neither core wraps the other. The Rust core serves MCP, HTTP and the CLI. It has no WebMCP binding, because WebMCP runs in a web page, and no language binding: Rust code in the same process opens a `Session`.

## Compare the TypeScript cores

| | `@acid-cat/core-ts` | `@acid-cat/core-effect` |
| --- | --- | --- |
| Capability | A function that returns a promise | An Effect program |
| Schemas | Any Standard Schema library | Effect Schema |
| Services | A context object | Layers |
| Cancellation | `AbortSignal` | Fiber interruption |
| MCP server | Built in | `effect/ai/McpServer` |
| Command line | Built in | `effect/cli` |
| Node.js server | `serve` from `@acid-cat/core-ts/node` | `NodeServer`, which serves in a scope |

## Choose a core

- Use `@acid-cat/core-ts` for plain TypeScript, without Effect.
- Use `@acid-cat/core-effect` if your application is written in Effect.
- Use `acid-cat-core` for a Rust service.

The same air conditioner exists on all three cores in [`examples/aircon`](https://github.com/Hebilicious/acidcat/blob/main/examples/aircon/README.md), so you can compare them.

## A core in another language

These packages are one implementation of the specification. A core in another language does not use them. It follows the [specification](/spec/), and `acid-cat conform` tests it from the outside. See [Conformance](/docs/concepts/conformance/).

## Read more

- [Serve with the TypeScript core](/docs/guides/serve-with-core-ts/)
- [Serve with the Effect core](/docs/guides/serve-with-core-effect/)
- [Serve with the Rust core](/docs/guides/serve-with-core-rust/)
- [Packages](/packages/), the list of published packages.
