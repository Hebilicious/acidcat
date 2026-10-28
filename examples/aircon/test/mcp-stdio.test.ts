import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

/** Start the MCP server of one core as a process, and connect an MCP client to it, as an agent does. */
async function connect(core: "core-ts" | "core-effect") {
  const server = new URL(`../${core}/mcp-stdio.ts`, import.meta.url).pathname;
  const client = new Client({ name: "aircon-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], stderr: "ignore" }));
  return client;
}

for (const core of ["core-ts", "core-effect"] as const) {
  test(`the MCP server of ${core} serves the mcp target through standard input and output`, async () => {
    const client = await connect(core);
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name).sort(), ["aircon.fan.set", "aircon.mode.set", "aircon.power.set", "aircon.status.get", "aircon.temperature.set"]);
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
