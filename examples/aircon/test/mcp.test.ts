import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { serve } from "@acid-cat/cli";
import type { Served } from "@acid-cat/cli";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { mcpApi } from "../apis/mcp.ts";

let served: Served;
let api: ReturnType<typeof mcpApi>;
before(async () => {
  api = mcpApi();
  served = await serve({ "/mcp": api.handler, "/capabilities": api.handler });
});
after(async () => {
  await served.close();
  await api.dispose();
});

/** The official MCP client, with revision 2026-07-28. */
async function connect(path: string): Promise<Client> {
  const client = new Client({ name: "example-test", version: "0.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${served.url}${path}`)));
  return client;
}

test("the server of the application has its own tools", async () => {
  const client = await connect("/mcp");
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["get_status", "set_controls"]);
  assert.equal(tools.find((tool) => tool.name === "get_status")?.annotations?.readOnlyHint, true);

  const poweredOff = await client.callTool({ name: "set_controls", arguments: { mode: "heat" } });
  assert.equal(poweredOff.isError, true);
  assert.match(JSON.stringify(poweredOff), /PoweredOff/);

  const changed = await client.callTool({ name: "set_controls", arguments: { power: true, mode: "heat", targetCelsius: 24 } });
  assert.equal(changed.isError ?? false, false);
  assert.deepEqual(changed.structuredContent, { power: true, mode: "heat", fan: "auto", targetCelsius: 24, roomCelsius: 25 });

  const invalid = await client.callTool({ name: "set_controls", arguments: { targetCelsius: 40 } }).then(
    (result) => result.isError === true,
    () => true,
  );
  assert.ok(invalid, "a temperature outside 16 to 31 must be refused");
});

test("the MCP binding serves one tool for each capability, on the same unit", async () => {
  const application = await connect("/mcp");
  await application.callTool({ name: "set_controls", arguments: { power: true, fan: "high" } });

  const binding = await connect("/capabilities/mcp");
  const { tools } = await binding.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "aircon.fan.set",
    "aircon.mode.set",
    "aircon.power.set",
    "aircon.schedule.set",
    "aircon.status.get",
    "aircon.temperature.set",
  ]);
  const status = await binding.callTool({ name: "aircon.status.get", arguments: {} });
  // The first test changed the power, the mode and the target temperature of the same unit.
  assert.deepEqual(status.structuredContent, { power: true, mode: "heat", fan: "high", targetCelsius: 24, roomCelsius: 25 });
});
