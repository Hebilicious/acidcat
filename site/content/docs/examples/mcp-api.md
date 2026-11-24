---
title: An MCP API with Effect
description: Hand-written MCP tools with effect/ai on a session of the Effect core, with the MCP events extension and a Server Card.
sidebar:
  order: 9
  label: MCP with Effect
tableOfContents: false
---

<FileLink file="apis/mcp.ts" /> serves two tools at `/mcp`: `get_status` and `set_controls`. `Mcp.withEvents` from `@acid-cat/core-effect` adds the [MCP events extension](/spec/surfaces/mcp/#events) for `aircon.status.changed`. The API also serves the MCP surface at `/capabilities/mcp` and `/capabilities/mcp-legacy`.

Run it from `examples/aircon` with the name `mcp`. It listens on `http://127.0.0.1:3000`:

<ExampleBlock section="Run an API" match="apis/main.ts" />

Follow `aircon.status.changed` through `events/stream`:

<ExampleBlock section="Run an API" match="3000/mcp" />

<CodeExplorer open="apis/mcp.ts" />
