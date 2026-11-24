---
title: Bindings
description: A binding is the set of rules that makes one kind of surface from the view of a target. AcidCat defines four protocol bindings and two language bindings.
sidebar:
  order: 15
---

A **binding** makes one kind of surface from the view of a target. One binding works for every catalog. It gets everything from the definitions of the application, so a new capability or a new event needs no change to the binding.

There are two kinds:

- A **protocol binding** makes a surface on the network or in a terminal, for example MCP or a command line. Any language can implement it.
- A **language binding** makes a surface in code, for example TypeScript or Rust. Applications use it in the same process. Each language binding follows the **programmatic binding**, the contract with no language.

The specification defines these bindings:

| Name | Kind | Surface | Events |
| --- | --- | --- | --- |
| `cli` | Protocol | A command line | `watch`, with one line of JSON for each occurrence |
| `mcp` | Protocol | An MCP server through HTTP, or through standard input and output | The MCP events extension |
| `http` | Protocol | JSON through HTTP | Server-sent events |
| `webmcp` | Protocol | WebMCP tools in a web page | None |
| `typescript` | Language | Handles in TypeScript and JavaScript | Async iterables |
| `rust` | Language | The functions of a session in Rust | `Occurrences`, read with `next` |

## CLI

The CLI binding serves a view as a command line. Each capability is a command, and the segments of its id give the path: `aircon.power.set` becomes `aircon power set`. Each top-level property of the input is a flag, for example `--celsius 22`. The target can also declare **aliases**, such as `home --on` or `home fan high`. The output is JSON, and each outcome has its own exit code: 0 for a value, 1 for a failure, 2 for an unknown command, and 130 after an interrupt. See the [CLI binding](/spec/bindings/cli/).

## MCP

The MCP binding serves a view as a Model Context Protocol server, through HTTP or through stdio. Each available capability is a tool with the id as its name. The tool gives the hints of the capability as `readOnlyHint`, `destructiveHint` and `idempotentHint`. A failure is a tool result with `isError: true`. Events use the MCP events extension, with push, poll and webhook delivery. See the [MCP binding](/spec/bindings/mcp/).

## HTTP

The HTTP binding serves a view as JSON through HTTP, for any HTTP client. `GET {base}/capabilities` lists the capabilities, and `POST {base}/capabilities/{id}` calls one with the input as the body. A result has the status 200. Each kind of call failure has its own status, for example 422 for `invalid-input`. `POST {base}/events/{id}` subscribes to an event, as a stream of server-sent events. See the [HTTP binding](/spec/bindings/http/).

## WebMCP

The WebMCP binding registers capabilities as WebMCP tools in a web page. Agents in the browser call these tools as the signed-in user. A capability is registered while it is available, and removed when it becomes unavailable. The binding does not serve events. A page that uses it usually also uses the TypeScript binding. See the [WebMCP binding](/spec/bindings/webmcp/).

## Language bindings

The [programmatic binding](/spec/bindings/programmatic/) is the contract of every language binding. It has no language. A session gives a **handle** for each capability in its view, with `execute`, its availability and its state, and an **event handle** for each event. A user interface uses the handles, and the protocol bindings use the same handles. Each language binding tells how a handle, a call, an outcome, an observable value and a cancellation look in its language:

- The [TypeScript binding](/spec/bindings/typescript/) uses objects, promises, `AbortSignal` and async iterables.
- The [Rust binding](/spec/bindings/rust/) uses an `Outcome` enum, cancellation tokens and an async `next`.

## Your own bindings and APIs

You can write other bindings to the same rules, for example for Swift, Kotlin or gRPC. A language binding for another language maps the programmatic binding. Give a new binding a prefixed name, such as `acme:swift`.

An API whose design you want to control, such as a GraphQL API, is application code. Build it on a session, with the library that you prefer, and keep the HTTP binding beside it for generic access. The air conditioner builds [GraphQL, Cap'n Web, Elysia and MCP APIs](https://github.com/Hebilicious/acidcat/blob/main/examples/aircon/README.md#apis) this way.

## Read more

- [Bindings](/spec/bindings/) in the specification: what each binding document tells, and the rules for remote bindings.
- [Extensions](/spec/extensions/): optional conventions for [attachments](/spec/extensions/attachments/) and [pagination](/spec/extensions/pagination/).
