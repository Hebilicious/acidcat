---
title: The air conditioner on the TypeScript core
description: The air conditioner on @acid-cat/core-ts, with Zod. A command line, an MCP server through stdio, a remote command-line server and a web page.
sidebar:
  order: 2
  label: TypeScript core
tableOfContents: false
---

<FileLink file="core-ts/aircon.ts" /> defines the application with `@acid-cat/core-ts` and Zod. Each other file of `core-ts/` serves it through one surface: <FileLink file="core-ts/cli.ts" />, <FileLink file="core-ts/mcp-stdio.ts" />, <FileLink file="core-ts/serve.ts" /> and <FileLink file="core-ts/page.ts" />.

Run it from `examples/aircon`:

<ExampleBlock section="The command line" match="core-ts/" />

Serve the command line to another process, and send a call to it:

<ExampleBlock section="Control a unit in another process" match="8080" />

Give this command to an MCP client, with the root of the repository as its working directory:

<ExampleBlock section="MCP server through stdio" match="core-ts/" />

<CodeExplorer open="core-ts/aircon.ts" />

See [Serve with the TypeScript core](/docs/guides/serve-with-core-ts/).
