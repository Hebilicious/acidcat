---
title: Examples
description: Programs that you can run, from the examples directory of the repository, with a code explorer for each one.
sidebar:
  order: 0
  label: Overview
tableOfContents: false
---

Each example is a directory of [`examples/`](https://github.com/Hebilicious/acidcat/tree/main/examples) in the repository. The code explorers on these pages read those files when the site is built, so the code is the code that the tests run.

## The air conditioner

A simulated air conditioner, described once in a catalog and served to every surface. The unit lives in memory, so each program runs without hardware.

- [The catalog in each language](/docs/examples/catalog/)

<CoreExamples />

- [The web page with WebMCP tools](/docs/examples/web-page/)
- APIs that you write on a session: [GraphQL](/docs/examples/graphql/), [Cap'n Web](/docs/examples/capnweb/), [Elysia](/docs/examples/elysia/) and [MCP with Effect](/docs/examples/mcp-api/)

## Run the examples

Install the dependencies from the root of the repository, then go to the example:

```sh
git clone https://github.com/Hebilicious/acidcat.git
cd acidcat
pnpm install
cd examples/aircon
```

Run all the tests of the example:

<ExampleBlock section="Run the tests" />

<CodeExplorer open="README.md" />
