---
title: Cores
description: A core is a library that runs your capabilities and events, and serves the surfaces. The repository has official cores, and any language can have one.
sidebar:
  order: 16
---

A **core** is a library that runs your capabilities and events, and serves the surfaces. You declare the capabilities in code. The core validates each input, runs your function, and gives each outcome the form of each surface. It can also write the catalog from your code.

## The official cores

The repository has these cores. Each core has the same features, in its own style, and passes `acid-cat conform`.

<EcosystemTable of="cores" />

Each TypeScript core serves the CLI, MCP, HTTP, WebMCP and TypeScript surfaces. No core wraps another core. The Rust core serves the CLI, MCP, HTTP and Rust surfaces. It has no WebMCP surface, because WebMCP runs in a web page.

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

The same air conditioner exists on each core in [`examples/aircon`](https://github.com/Hebilicious/acidcat/blob/main/examples/aircon/README.md), so you can compare them.

## A core in another language

These packages are one implementation of the specification. A core in another language does not use them. It follows the [specification](/spec/), and `acid-cat conform` tests it from the outside. See [Conformance](/docs/concepts/conformance/).

## Read more

- <CoreGuides />
- [Packages](/packages/), the list of published packages.
