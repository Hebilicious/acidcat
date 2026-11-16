#!/usr/bin/env node
import { mcpStdioMain } from "@acid-cat/core-ts";
import { aircon, toJsonSchema, Unit } from "./aircon.ts";

mcpStdioMain(aircon, { name: "aircon", version: "0.1.0", context: { unit: new Unit() }, toJsonSchema });
