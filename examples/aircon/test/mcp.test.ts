import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { serve } from "@acid-cat/cli";
import type { Served } from "@acid-cat/cli";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";

import { mcpApi } from "../apis/mcp.ts";
import { until } from "./until.ts";

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
  const setControls = tools.find((tool) => tool.name === "set_controls");
  assert.equal(setControls?.annotations?.destructiveHint, true);
  assert.equal(setControls?.annotations?.idempotentHint, true);

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

test("the MCP surface serves one tool for each capability, on the same unit", async () => {
  const application = await connect("/mcp");
  await application.callTool({ name: "set_controls", arguments: { power: true, mode: "heat", fan: "high", targetCelsius: 24 } });

  const surface = await connect("/capabilities/mcp");
  const { tools } = await surface.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "aircon.fan.set",
    "aircon.mode.set",
    "aircon.power.set",
    "aircon.schedule.set",
    "aircon.status.get",
    "aircon.temperature.set",
  ]);
  const status = await surface.callTool({ name: "aircon.status.get", arguments: {} });
  assert.deepEqual(status.structuredContent, { power: true, mode: "heat", fan: "high", targetCelsius: 24, roomCelsius: 25 });
});

test("the MCP surface gives the x-mcp-header annotation of aircon.power.set, and rejects a call whose Mcp-Param-On header does not agree with on", async () => {
  const client = await connect("/capabilities/mcp");
  const { tools } = await client.listTools();
  const inputSchema = z.object({ properties: z.object({ on: z.looseObject({ "x-mcp-header": z.string() }) }) }).parse(tools.find((tool) => tool.name === "aircon.power.set")?.inputSchema);
  assert.equal(inputSchema.properties.on["x-mcp-header"], "On");
  const mirrored = await client.callTool({ name: "aircon.power.set", arguments: { on: true } });
  assert.equal(mirrored.isError ?? false, false);
  await client.close();

  const call = (headers: Record<string, string>) =>
    fetch(`${served.url}/capabilities/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "aircon.power.set", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "aircon.power.set", arguments: { on: false }, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } }),
    });
  for (const headers of [{}, { "Mcp-Param-On": "true" }]) {
    const rejected = await call(headers);
    assert.equal(rejected.status, 400);
    assert.equal(Message.parse(await rejected.json()).error?.code, -32020);
  }
  assert.equal((await call({ "Mcp-Param-On": "false" })).status, 200);
});

test("the MCP surface serves revision 2026-07-28 only, and the wrapped surface serves the initialize handshake too", async () => {
  // The default of the official client is the initialize handshake of revision 2025-11-25. When this default becomes
  // revision 2026-07-28, this test fails: see the roadmap of spec/surfaces/mcp.md.
  const legacy = () => new Client({ name: "example-test", version: "0.0.0" });
  await assert.rejects(legacy().connect(new StreamableHTTPClientTransport(new URL(`${served.url}/capabilities/mcp`))));

  const client = legacy();
  await client.connect(new StreamableHTTPClientTransport(new URL(`${served.url}/capabilities/mcp-legacy`)));
  assert.equal(client.getNegotiatedProtocolVersion(), "2025-11-25");
  const { tools } = await client.listTools();
  assert.ok(tools.some((tool) => tool.name === "aircon.status.get"));
  const status = await client.callTool({ name: "aircon.status.get", arguments: {} });
  assert.equal(status.isError ?? false, false);
  assert.equal(typeof status.structuredContent, "object");
  const powered = await client.callTool({ name: "aircon.power.set", arguments: { on: true } });
  assert.equal(powered.isError ?? false, false, "the wrapper mirrors the argument on into the header Mcp-Param-On");
  await client.close();

  const current = await connect("/capabilities/mcp-legacy");
  assert.equal(current.getNegotiatedProtocolVersion(), "2026-07-28");
  await current.close();
});


const Message = z.looseObject({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.looseObject({ code: z.number() }).optional(),
});

function eventsRequest(id: string, method: string, params: Record<string, unknown>, signal?: AbortSignal) {
  return fetch(`${served.url}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Method": method,
      "MCP-Protocol-Version": "2026-07-28",
      ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } }),
    ...(signal === undefined ? {} : { signal }),
  });
}

function sseMessages(response: Response) {
  assert.ok(response.body);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  return async () => {
    for (;;) {
      const end = buffered.indexOf("\n\n");
      if (end >= 0) {
        const data = buffered
          .slice(0, end)
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        buffered = buffered.slice(end + 2);
        if (data !== "") return Message.parse(JSON.parse(data));
        continue;
      }
      const chunk = await reader.read();
      if (chunk.done) return undefined;
      buffered += chunk.value;
    }
  };
}

test("the server of the application declares the events extension, and lists aircon.status.changed", async () => {
  const discovered = Message.parse(await (await eventsRequest("d", "server/discover", {})).json());
  assert.deepEqual(z.looseObject({ capabilities: z.looseObject({ extensions: z.record(z.string(), z.unknown()) }) }).parse(discovered.result).capabilities.extensions, {
    "io.modelcontextprotocol/events": {},
  });
  const listed = Message.parse(await (await eventsRequest("l", "events/list", {})).json());
  const events = z.object({ events: z.array(z.looseObject({ name: z.string(), delivery: z.array(z.string()) })) }).parse(listed.result).events;
  assert.deepEqual(events.map((each) => [each.name, each.delivery]), [["aircon.status.changed", ["push", "poll"]]]);
});

test("events/stream on the server of the application grants the suggested heartbeatMs, follows aircon.status.changed, and cancelling it stops listening to the unit", async (t) => {
  const client = await connect("/mcp");
  const before = api.statusListeners();
  const controller = new AbortController();
  const next = sseMessages(await eventsRequest("s", "events/stream", { name: "aircon.status.changed", arguments: {}, heartbeatMs: 30_000 }, controller.signal));
  const active = await next();
  assert.equal(active?.method, "notifications/events/active");
  assert.equal(active?.params?.heartbeatMs, 30_000);
  await until(t, () => api.statusListeners() === before + 1, Boolean, { what: "the subscription listens to the unit" });
  await client.callTool({ name: "set_controls", arguments: { power: true, fan: "low" } });
  const event = await next();
  assert.equal(event?.method, "notifications/events/event");
  assert.equal(event?.params?.name, "aircon.status.changed");
  assert.equal(z.looseObject({ fan: z.string() }).parse(event?.params?.data).fan, "low");
  controller.abort();
  await until(t, () => api.statusListeners() === before, Boolean, { what: "the subscription stops listening to the unit" });
  await client.close();
});

test("events/poll on the server of the application reads aircon.status.changed from a lease", async (t) => {
  const client = await connect("/mcp");
  const poll = async (cursor?: string) => {
    const message = Message.parse(await (await eventsRequest("p", "events/poll", { name: "aircon.status.changed", arguments: {}, ...(cursor === undefined ? {} : { cursor }) })).json());
    return z.object({ events: z.array(z.looseObject({ data: z.looseObject({ fan: z.string() }) })), cursor: z.string() }).parse(message.result);
  };
  const before = api.statusListeners();
  const started = await poll();
  assert.deepEqual(started.events, []);
  assert.equal(api.statusListeners(), before + 1, "the lease listens to the unit");
  await client.callTool({ name: "set_controls", arguments: { power: true, fan: "medium" } });
  const polled = await until(t, () => poll(started.cursor), (seen) => seen.events.length > 0);
  assert.deepEqual(polled.events.map((each) => each.data.fan), ["medium"]);
  await client.close();
});

test("the MCP surface serves a Server Card, and the wrapped surface adds the revisions of the handshake", async () => {
  const Card = z.object({ name: z.string(), version: z.string(), remotes: z.array(z.object({ url: z.string(), supportedProtocolVersions: z.array(z.string()) })) });
  const response = await fetch(`${served.url}/capabilities/mcp/server-card`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/mcp-server-card+json");
  const card = Card.parse(await response.json());
  assert.deepEqual([card.name, card.version], ["dev.acid-cat/aircon", "0.1.0"]);
  assert.deepEqual(card.remotes, [{ url: `${served.url}/capabilities/mcp`, supportedProtocolVersions: ["2026-07-28"] }]);
  const legacy = Card.parse(await (await fetch(`${served.url}/capabilities/mcp-legacy/server-card`)).json());
  assert.deepEqual(legacy.remotes, [{ url: `${served.url}/capabilities/mcp-legacy`, supportedProtocolVersions: ["2026-07-28", "2025-11-25", "2025-06-18"] }]);
});

test("the server of the application, behind Mcp.withEvents, serves a Server Card with the version of its server/discover", async () => {
  const Card = z.object({ name: z.string(), version: z.string(), description: z.string(), remotes: z.array(z.object({ url: z.string(), supportedProtocolVersions: z.array(z.string()) })) });
  const response = await fetch(`${served.url}/mcp/server-card`);
  assert.equal(response.status, 200);
  const card = Card.parse(await response.json());
  const client = await connect("/mcp");
  assert.deepEqual([card.name, card.version], ["dev.acid-cat/aircon", client.getServerVersion()?.version]);
  assert.equal(card.version, "0.1.0");
  assert.deepEqual(card.remotes, [{ url: `${served.url}/mcp`, supportedProtocolVersions: ["2026-07-28"] }]);
  await client.close();
});
