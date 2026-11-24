---
title: Introduction
description: AcidCat lists the operations of an application once, in a catalog, and serves them through every surface.
sidebar:
  order: 0
  label: Introduction
---

AcidCat lists the operations of an application once, in a **catalog**. Each **surface** of the application comes from that catalog: a command line, an MCP server for AI agents, an HTTP API, tools in a web page, and handles in code.

The name stands for **A**pplication **C**apability **Id**entification **Cat**alog.

::: caution Experimental
The specification is a draft, and the packages are `0.x`. A minor release can break their APIs. Pin exact versions.
:::

## The problem

An application has many front doors: its user interface, a command line, an MCP server, an HTTP API. Usually each one implements the same operations again, with its own names, its own validation and its own errors. Over time, they drift apart.

AcidCat removes the copies. You describe each operation one time. Every surface takes the same input, returns the same failures, and shows each client only the operations that it can use.

## One capability, five surfaces

An operation in the catalog is a **capability**. This table shows one capability, `aircon.power.set`, on each surface:

| Surface | The capability `aircon.power.set` becomes |
| --- | --- |
| Command line | `home aircon power set --on` |
| MCP server | The tool `aircon.power.set` |
| WebMCP | A tool that a browser agent calls in your web page, as the signed-in user |
| HTTP | `POST /capabilities/aircon.power.set` |
| Code | A handle, for example `execute({ on: true })` in TypeScript |

The catalog declares the capability one time. Write it in the source that you prefer. Each source writes the same JSON:

<CatalogExample capability="aircon.power.set" />

## How the parts fit

<CatalogFlow />

- The **catalog** is the contract. It is a JSON document that you check at build time. A program does not read it at run time.
- A **target** is a group of clients and what they can use, for example `cli` or `mcp`. Each target sees only its part of the catalog, the **catalog of the target**.
- A **surface** is one way for clients to reach a target: MCP, WebMCP, the CLI, HTTP, or a language such as TypeScript or Rust. AcidCat serves one catalog through many surfaces, and the specification defines each one.
- A **provider** is your code that does the operation. A **core** is a library that runs your providers and serves the surfaces.
- `acid-cat conform` tests a running program from the outside, through each surface.

AcidCat is a specification first. The TypeScript and Rust packages are one implementation of it. A program in any language that follows the [specification](/spec/) and passes `acid-cat conform` is also an implementation.

## Where to go next

<CardGrid>
  <LinkCard title="Quick start" description="Declare a capability, check the catalog, and serve it as a CLI, an MCP server and an HTTP API." href="/docs/quick-start/" />
  <LinkCard title="Concepts" description="Catalogs, capabilities, targets, events, surfaces, cores and conformance, one page each." href="/docs/concepts/catalog/" />
  <LinkCard title="Guides" description="Write a catalog in your language, serve it with a core, and test an implementation." href="/docs/guides/write-a-catalog/" />
  <LinkCard title="Examples" description="Programs that you can run, each with a code explorer on its source." href="/docs/examples/" />
  <LinkCard title="The acid-cat command" description="Every command and flag of the command-line tool." href="/docs/reference/cli/" />
  <LinkCard title="Specification" description="The normative rules: catalog, invocation, events, surfaces and conformance." href="/spec/" />
  <LinkCard title="Packages" description="The published packages: the command line, the cores and the catalog libraries." href="/packages/" />
</CardGrid>
