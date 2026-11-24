---
title: A Cap'n Web API
description: A Cap'n Web API on a session of the TypeScript core, with typed methods over HTTP batches and WebSockets.
sidebar:
  order: 7
  label: Cap'n Web
tableOfContents: false
---

<FileLink file="apis/capnweb.ts" /> is a class with typed methods. `followStatus(listener)` calls the function of the client with each new status, until the client disposes the result. A failure is `{ ok: false, error }`.

Run it from `examples/aircon` with the name `capnweb`. It listens on `http://127.0.0.1:3000`, and on `ws://127.0.0.1:3001/rpc`:

<ExampleBlock section="Run an API" match="apis/main.ts" />

A client:

<ExampleBlock section="Run an API" language="ts" />

<CodeExplorer open="apis/capnweb.ts" />
