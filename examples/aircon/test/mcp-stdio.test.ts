import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { bundledProgram } from "./bundled-program.ts";

const rust = new URL("../core-rust/target/debug/aircon", import.meta.url).pathname;

function command(core: "core-ts" | "core-effect" | "core-rust") {
  if (core === "core-rust") return { command: rust, args: ["mcp-stdio"] };
  return { command: process.execPath, args: [bundledProgram(`${core}/mcp-stdio.ts`)] };
}

async function connect(core: "core-ts" | "core-effect" | "core-rust") {
  const client = new Client({ name: "aircon-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ ...command(core), stderr: "ignore" }));
  return client;
}

for (const core of ["core-ts", "core-effect", "core-rust"] as const) {
  test(`the MCP server of ${core} serves the mcp target through standard input and output`, async () => {
    const client = await connect(core);
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name).sort(), ["aircon.fan.set", "aircon.mode.set", "aircon.power.set", "aircon.schedule.set", "aircon.status.get", "aircon.temperature.set"]);
      const powerSet = tools.find((tool) => tool.name === "aircon.power.set");
      assert.equal(powerSet?.annotations?.destructiveHint, true);
      assert.deepEqual(powerSet?.inputSchema.properties?.["on"], { type: "boolean", "x-mcp-header": "On" });
      assert.equal(powerSet?.annotations?.idempotentHint, true);
      const poweredOff = await client.callTool({ name: "aircon.mode.set", arguments: { mode: "heat" } });
      assert.equal(poweredOff.isError, true);
      await client.callTool({ name: "aircon.power.set", arguments: { on: true } });
      const status = await client.callTool({ name: "aircon.status.get", arguments: {} });
      assert.deepEqual(status.structuredContent, { power: true, mode: "cool", fan: "auto", targetCelsius: 22, roomCelsius: 25 });
    } finally {
      await client.close();
    }
  });
}
