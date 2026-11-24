---
title: A GraphQL API
description: A GraphQL API on a session of the TypeScript core, with Pothos, GraphQL Yoga and subscriptions through server-sent events and WebSockets.
sidebar:
  order: 6
  label: GraphQL
tableOfContents: false
---

<FileLink file="apis/graphql.ts" /> is application code on a session: `query { status }`, mutations that return the new status, and `subscription { statusChanged }`. A failure is a member of a union, for example `Status | Offline | PoweredOff`. <FileLink file="apis/schema.graphql" /> is the schema. The API also serves the HTTP surface at `/api`.

Run it from `examples/aircon` with the name `graphql`. It listens on `http://127.0.0.1:3000`:

<ExampleBlock section="Run an API" match="apis/main.ts" />

Follow the changes in one terminal, and change the unit in another:

<ExampleBlock section="Run an API" match="3000/graphql" />

<CodeExplorer open="apis/graphql.ts" />
