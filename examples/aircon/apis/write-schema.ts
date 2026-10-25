/**
 * Write the schema of the GraphQL API to `schema.graphql`, so that a reader can see it without running the API. The
 * test of the API checks that the file is current.
 *
 * Usage: node apis/write-schema.ts
 */
import { writeFileSync } from "node:fs";

import { printSchema } from "graphql";

import { schema } from "./graphql.ts";

writeFileSync(new URL("schema.graphql", import.meta.url), `${printSchema(schema)}\n`);
