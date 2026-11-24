import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { Client } from "@modelcontextprotocol/client";
import type { ClientOptions } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { isObject, memberOf } from "../json.ts";
import type { JsonObject } from "../json.ts";
import { abortable, Checks, expect, expectEqual, until } from "./check.ts";
import { checkEvents, checkTools, META, subscriptionOf } from "./mcp.ts";
import type { Channel, EventStream, Message } from "./mcp.ts";
import type { PollSettings } from "./poll.ts";
import { checkProperties, clientInvoke } from "./properties.ts";

const RULE = "spec/surfaces/mcp.md#stdio";

const ERAS = [
  { revision: "2026-07-28", connects: "an MCP client connects with revision 2026-07-28", options: { versionNegotiation: { mode: { pin: "2026-07-28" } } } },
  { revision: "2025-11-25", connects: "an MCP client connects with the initialize handshake of revision 2025-11-25", options: {} },
] as const;

function environment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).flatMap(([name, value]) => (value === undefined ? [] : [[name, value]])));
}

async function connect(command: readonly string[], options: ClientOptions, changes: { count: number }, signal: AbortSignal): Promise<Client> {
  const [program, ...args] = command;
  if (program === undefined) throw new Error("the command that starts the MCP server is empty");
  const client = new Client(
    { name: "acid-cat-conform", version: "0.1.0" },
    { ...options, listChanged: { tools: { autoRefresh: false, debounceMs: 0, onChanged: () => void (changes.count += 1) } } },
  );
  const transport = new StdioClientTransport({ command: program, args, env: environment(), stderr: "ignore" });
  await client.connect(transport, { signal });
  return client;
}

export async function checkMcpStdio(command: readonly string[], options: { readonly deadline: number; readonly poll: PollSettings }): Promise<readonly Checks[]> {
  const all: Checks[] = [];
  for (const era of ERAS) {
    const checks = new Checks(`mcp-stdio ${era.revision}`, options.deadline);
    all.push(checks);
    const changes = { count: 0 };
    let client: Client | undefined;
    await checks.run(era.connects, RULE, async (signal) => {
      client = await connect(command, era.options, changes, signal);
      expectEqual(client.getNegotiatedProtocolVersion(), era.revision, "the revision of the session");
    });
    if (client === undefined) continue;
    const mcp = client;
    try {
      await checkTools(checks, mcp);
      await checkChanges(checks, mcp, changes);
      all.push(await checkProperties(`mcp-stdio ${era.revision} properties`, clientInvoke(mcp), options.deadline));
    } finally {
      await mcp.close();
    }
  }
  all.push(await checkLines(command, options));
  all.push(await checkStdioEvents(command, options));
  return all;
}

async function checkStdioEvents(command: readonly string[], options: { readonly deadline: number; readonly poll: PollSettings }): Promise<Checks> {
  const checks = new Checks("mcp-stdio events", options.deadline);
  const controller = new AbortController();
  const server = startRaw(command, controller.signal);
  try {
    await checkEvents(checks, stdioChannel(server), { transport: "stdio", poll: options.poll, webhook: false });
  } finally {
    controller.abort();
  }
  return checks;
}

function stdioChannel(server: ReturnType<typeof startRaw>): Channel {
  let next = 0;
  const send = (id: string, method: string, params: JsonObject) =>
    server.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: META } }));
  return {
    async request(method, params, signal) {
      const id = `conform-request-${(next += 1)}`;
      send(id, method, params);
      return until(`the response to ${method}`, async () => server.messages.find((message) => memberOf(message, "id") === id), isObject, signal);
    },
    async stream(id, params, signal): Promise<EventStream> {
      send(id, "events/stream", params);
      const belongs = (message: unknown): message is Message => isObject(message) && (message.id === id || subscriptionOf(message) === id);
      let position = 0;
      let ended = false;
      return {
        async next() {
          if (ended) return undefined;
          const found = await until(
            "the next message of the subscription",
            async () => server.messages.slice(position).findIndex(belongs),
            (index) => index >= 0,
            signal,
          );
          const message = server.messages[position + found];
          position += found + 1;
          if (!belongs(message)) throw new Error("the message of the subscription is not a JSON-RPC message");
          if (message.id === id) ended = true;
          return message;
        },
        async cancel() {
          if (ended) return;
          ended = true;
          server.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } }));
        },
      };
    },
  };
}

async function checkChanges(checks: Checks, mcp: Client, changes: { readonly count: number }): Promise<void> {
  const set = (on: boolean, signal: AbortSignal) => mcp.callTool({ name: "fixture.switch.set", arguments: { on } }, { signal });
  const listsToggle = async (signal: AbortSignal) => (await mcp.listTools(undefined, { signal })).tools.some((tool) => tool.name === "fixture.toggle");
  await checks.run("notifications/tools/list_changed comes when a capability becomes unavailable or available", RULE, async (signal) => {
    try {
      const before = changes.count;
      await set(false, signal);
      await until("notifications/tools/list_changed comes", async () => changes.count, (count) => count > before, signal);
      expect(!(await listsToggle(signal)), "fixture.toggle must not be listed while it is unavailable");
      const off = changes.count;
      await set(true, signal);
      await until("notifications/tools/list_changed comes again", async () => changes.count, (count) => count > off, signal);
      expect(await listsToggle(signal), "fixture.toggle must be listed when it is available again");
    } finally {
      await set(true, AbortSignal.timeout(checks.deadline));
    }
  });
}

function startRaw(command: readonly string[], signal: AbortSignal) {
  const [program, ...args] = command;
  if (program === undefined) throw new Error("the command that starts the MCP server is empty");
  const child = spawn(program, args, { stdio: ["pipe", "pipe", "ignore"], signal, killSignal: "SIGKILL" });
  const lines: string[] = [];
  const messages: unknown[] = [];
  let rest = "";
  child.stdout.on("data", (chunk: Buffer) => {
    const parts = (rest + chunk.toString()).split("\n");
    rest = parts.pop() ?? "";
    for (const line of parts) {
      lines.push(line);
      try {
        messages.push(JSON.parse(line));
      } catch {
        messages.push(undefined);
      }
    }
  });
  child.stdin.on("error", () => undefined);
  const exited = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on("error", (error) => reject(signal.aborted ? new Error("waiting until the MCP server exits") : error));
    child.on("close", (code, exitSignal) => resolve({ code, signal: exitSignal }));
  });
  exited.catch(() => undefined);
  let next = 0;
  const write = (line: string) => child.stdin.write(`${line}\n`);
  const request = async (method: string, params: JsonObject = {}): Promise<JsonObject> => {
    const id = `conform-${(next += 1)}`;
    write(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return until(`the response to ${method}`, async () => messages.find((message) => memberOf(message, "id") === id), isObject, signal);
  };
  return { child, lines, messages, write, request, exited };
}

async function handshake(server: ReturnType<typeof startRaw>, revision = "2025-11-25"): Promise<JsonObject> {
  const response = await server.request("initialize", { protocolVersion: revision, capabilities: {}, clientInfo: { name: "acid-cat-conform", version: "0.1.0" } });
  server.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  return response;
}

async function checkLines(command: readonly string[], options: { readonly deadline: number }): Promise<Checks> {
  const checks = new Checks("mcp-stdio", options.deadline);
  const withServer = (body: (server: ReturnType<typeof startRaw>, signal: AbortSignal) => Promise<void>) => async (signal: AbortSignal) => {
    const controller = new AbortController();
    const server = startRaw(command, AbortSignal.any([controller.signal, signal]));
    try {
      await body(server, signal);
    } finally {
      controller.abort();
    }
  };

  await checks.run(
    "initialize with a revision that the server does not serve gives a revision that it serves",
    RULE,
    withServer(async (server) => {
      const response = await handshake(server, "1999-01-01");
      const version = memberOf(memberOf(response, "result"), "protocolVersion");
      expect(typeof version === "string" && version !== "1999-01-01", `expected another revision, got ${JSON.stringify(response)}`);
    }),
  );

  await checks.run(
    "a line that is not JSON gets the error -32700, and the session stays open",
    RULE,
    withServer(async (server, signal) => {
      await handshake(server);
      server.write("{");
      const parseError = await until(
        "the error -32700",
        async () => server.messages.find((message) => memberOf(memberOf(message, "error"), "code") === -32700),
        isObject,
        signal,
      );
      expectEqual(parseError["id"], null, "the id of the error");
      const echo = await server.request("tools/call", { name: "fixture.echo", arguments: { text: "after" } });
      expectEqual(memberOf(memberOf(echo, "result"), "structuredContent"), { text: "after" }, "structuredContent after the error");
    }),
  );

  await checks.run(
    "standard output has only JSON-RPC messages, also after a defect",
    RULE,
    withServer(async (server) => {
      await handshake(server);
      await server.request("tools/list");
      await server.request("tools/call", { name: "fixture.crash", arguments: {} });
      await server.request("tools/call", { name: "fixture.echo", arguments: { text: "last" } });
      const other = server.messages.findIndex((message) => memberOf(message, "jsonrpc") !== "2.0");
      expect(other === -1, `standard output must have only JSON-RPC messages, got the line ${JSON.stringify(server.lines[other])}`);
    }),
  );

  await checks.run(
    "the server exits when standard input ends, also during a call",
    RULE,
    withServer(async (server, signal) => {
      await handshake(server);
      const key = randomUUID();
      server.write(JSON.stringify({ jsonrpc: "2.0", id: "conform-hold", method: "tools/call", params: { name: "fixture.hold", arguments: { key } } }));
      const held = async () => {
        const response = await server.request("tools/call", { name: "fixture.held", arguments: {} });
        return memberOf(memberOf(memberOf(response, "result"), "structuredContent"), "keys");
      };
      await until("fixture.held gives the key of the call", held, (keys) => Array.isArray(keys) && keys.includes(key), signal);
      server.child.stdin.end();
      const exit = await abortable(server.exited, signal);
      expect(exit.signal === null, `the process must exit, not end by the signal ${exit.signal}`);
    }),
  );

  return checks;
}
