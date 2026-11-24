---
title: Surfaces
description: A surface is one way for clients to reach a target, such as MCP, WebMCP, the CLI, HTTP or a language. AcidCat serves one catalog through many surfaces.
sidebar:
  order: 15
---

AcidCat serves one catalog through many **surfaces**: MCP, WebMCP, the command line (CLI), HTTP, and languages such as TypeScript and Rust. The clients of the CLI use commands, the clients of MCP use tools, and code uses handles. A core serves each surface by the rules of the [specification](/spec/surfaces/). A new capability or a new event needs no change to a surface.

MCP, WebMCP, the CLI and HTTP are **protocol surfaces**: any language can implement them. TypeScript and Rust are **language surfaces**: code uses them in the same process, and each one maps the **programmatic surface** to its language.

The specification defines these surfaces:

| Name | Kind | What clients use | Events |
| --- | --- | --- | --- |
| `cli` | Protocol | A command line | `watch`, with one line of JSON for each occurrence |
| `mcp` | Protocol | An MCP server through HTTP, or through standard input and output | The MCP events extension |
| `http` | Protocol | JSON through HTTP | Server-sent events |
| `webmcp` | Protocol | WebMCP tools in a web page | None |
| `typescript` | Language | Handles in TypeScript and JavaScript | Async iterables |
| `rust` | Language | The functions of a session in Rust | `Occurrences`, read with `next` |

## CLI

The CLI surface serves the catalog of a target as a command line. Each capability is a command, and the segments of its id give the path: `aircon.power.set` becomes `aircon power set`. Each top-level property of the input is a flag, for example `--celsius 22`. The target can also declare **aliases**, such as `home --on` or `home fan high`. The output is JSON, and each outcome has its own exit code: 0 for a value, 1 for a failure, 2 for an unknown command, and 130 after an interrupt. See the [CLI surface](/spec/surfaces/cli/).

## MCP

The MCP surface serves the catalog of a target as a Model Context Protocol server, through HTTP or through stdio. Each available capability is a tool with the id as its name. The tool gives the hints of the capability as `readOnlyHint`, `destructiveHint` and `idempotentHint`. A failure is a tool result with `isError: true`. Events use the MCP events extension, with push, poll and webhook delivery. See the [MCP surface](/spec/surfaces/mcp/).

## HTTP

The HTTP surface serves the catalog of a target as JSON through HTTP, for any HTTP client. `GET {base}/capabilities` lists the capabilities, and `POST {base}/capabilities/{id}` calls one with the input as the body. A result has the status 200. Each kind of call failure has its own status, for example 422 for `invalid-input`. `POST {base}/events/{id}` subscribes to an event, as a stream of server-sent events. See the [HTTP surface](/spec/surfaces/http/).

## WebMCP

The WebMCP surface registers capabilities as WebMCP tools in a web page. Agents in the browser call these tools as the signed-in user. A capability is registered while it is available, and removed when it becomes unavailable. The surface does not serve events. A page that uses it usually also uses the TypeScript surface. See the [WebMCP surface](/spec/surfaces/webmcp/).

## Language surfaces

The [programmatic surface](/spec/surfaces/programmatic/) is the contract of every language surface. It has no language. A session gives a **handle** for each capability in its target, with `execute`, its availability and its state, and an **event handle** for each event. A user interface uses the handles, and the protocol surfaces use the same handles. Each language surface tells how a handle, a call, an outcome, an observable value and a cancellation look in its language:

- The [TypeScript surface](/spec/surfaces/typescript/) uses objects, promises, `AbortSignal` and async iterables.
- The [Rust surface](/spec/surfaces/rust/) uses an `Outcome` enum, cancellation tokens and an async `next`.

## Your own surfaces and APIs

You can write other surfaces to the same rules, for example for Swift, Kotlin or gRPC. A language surface for another language maps the programmatic surface. Give a new surface a prefixed name, such as `acme:swift`.

An API whose design you want to control, such as a GraphQL API, is application code. Build it on a session, with the library that you prefer, and keep the HTTP surface beside it for generic access. The air conditioner builds [GraphQL, Cap'n Web, Elysia and MCP APIs](https://github.com/Hebilicious/acidcat/blob/main/examples/aircon/README.md#apis) this way.

## Read more

- [Surfaces](/spec/surfaces/) in the specification: what each surface document tells, and the rules for remote surfaces.
- [Extensions](/spec/extensions/): optional conventions for [attachments](/spec/extensions/attachments/) and [pagination](/spec/extensions/pagination/).
