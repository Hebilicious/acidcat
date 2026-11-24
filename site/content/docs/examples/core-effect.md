---
title: The air conditioner on the Effect core
description: The air conditioner on @acid-cat/core-effect, written in Effect. A command line, an MCP server through stdio, a remote command-line server and a web page.
sidebar:
  order: 3
  label: Effect core
tableOfContents: false
---

<FileLink file="core-effect/aircon.ts" /> defines the same application as the TypeScript core, with `@acid-cat/core-effect` and Effect Schema. Capabilities are Effect programs, and the unit is a service. <FileLink file="core-effect/output.ts" /> formats the human output of the command line.

Run it from `examples/aircon`:

<ExampleBlock section="The command line" match="core-effect/" />

Serve the command line to another process, and send a call to it:

<ExampleBlock section="Control a unit in another process" match="8081" />

Give this command to an MCP client, with the root of the repository as its working directory:

<ExampleBlock section="MCP server through stdio" match="core-effect/" />

<CodeExplorer open="core-effect/aircon.ts" />

See [Serve with the Effect core](/docs/guides/serve-with-core-effect/).
