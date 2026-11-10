import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { serve } from "@acid-cat/cli";
import type { Served } from "@acid-cat/cli";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";

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

test("the MCP binding serves revision 2026-07-28 only, and the wrapped binding serves the initialize handshake too", async () => {
  // The default of the official client is the initialize handshake of revision 2025-11-25. When this default becomes
  // revision 2026-07-28, this test fails: see the roadmap of spec/bindings/mcp.md.
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
  await client.close();

  const current = await connect("/capabilities/mcp-legacy");
  assert.equal(current.getNegotiatedProtocolVersion(), "2026-07-28");
  await current.close();
});

// --- Events of the server of the application -----------------------------------------------------------------------

/** Wait until a condition is true, or fail after five seconds. */
async function until(what: string, condition: () => boolean): Promise<void> {
  const end = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A JSON-RPC message, with the members that the tests read. */
const Message = z.looseObject({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.looseObject({ code: z.number() }).optional(),
});

/** One request of the events extension to the server of the application, with the headers of revision 2026-07-28. */
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

/** The JSON-RPC messages of a stream of server-sent events, one at a time. */
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

test("events/stream on the server of the application follows aircon.status.changed, and cancelling it stops listening to the unit", async () => {
  const client = await connect("/mcp");
  const before = api.statusListeners();
  const controller = new AbortController();
  const next = sseMessages(await eventsRequest("s", "events/stream", { name: "aircon.status.changed", arguments: {} }, controller.signal));
  assert.equal((await next())?.method, "notifications/events/active");
  await until("the subscription listens to the unit", () => api.statusListeners() === before + 1);
  await client.callTool({ name: "set_controls", arguments: { power: true, fan: "low" } });
  const event = await next();
  assert.equal(event?.method, "notifications/events/event");
  assert.equal(event?.params?.name, "aircon.status.changed");
  assert.equal(z.looseObject({ fan: z.string() }).parse(event?.params?.data).fan, "low");
  controller.abort();
  await until("the subscription stops listening to the unit", () => api.statusListeners() === before);
  await client.close();
});

test("events/poll on the server of the application reads aircon.status.changed from a lease", async () => {
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
  let polled = await poll(started.cursor);
  for (const end = Date.now() + 5000; polled.events.length === 0 && Date.now() < end; polled = await poll(started.cursor)) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(polled.events.map((each) => each.data.fan), ["medium"]);
  await client.close();
});
