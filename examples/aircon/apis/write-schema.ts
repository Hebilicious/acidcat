import { writeFileSync } from "node:fs";

import { printSchema } from "graphql";

import { schema } from "./graphql.ts";

writeFileSync(new URL("schema.graphql", import.meta.url), `${printSchema(schema)}\n`);
