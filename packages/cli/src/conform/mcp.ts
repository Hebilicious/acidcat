/**
 * Conformance checks for the MCP binding through HTTP (spec/bindings/mcp.md). The protocol checks use the official MCP
 * client with revision 2026-07-28. With `handshake`, they run again with the `initialize` handshake of revision
 * 2025-11-25. The other checks send requests that a client never sends.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { isObject, memberOf, parseJson, readJson } from "../json.ts";
import { Checks, expect, expectEqual, fixture, FORBIDDEN_ORIGIN, idsOf, sorted } from "./check.ts";

const RULE = "spec/bindings/mcp.md";

/** A tool result, as the MCP client gives it. */
type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

/** A connected MCP client. With `handshake`, the client opens the session with `initialize`. */
export async function mcpClient(url: string, signal?: AbortSignal, handshake = false): Promise<Client> {
  const client = new Client({ name: "acid-cat-conform", version: "0.1.0" }, handshake ? {} : { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)), signal ? { signal } : undefined);
  return client;
}

/** The JSON value in the first text content of a tool result, or `null` when there is no text content. */
const textOf = (result: ToolResult): unknown => {
  const first = result.content[0];
  return parseJson(first?.type === "text" ? first.text : "null");
};

export async function checkMcp(url: string, options: { readonly maximumBytes: number; readonly deadline: number; readonly handshake: boolean }): Promise<Checks> {
  const checks = new Checks("mcp", options.deadline);
  let client: Client | undefined;

  await checks.run("an MCP client connects with revision 2026-07-28", `${RULE}#http`, async (signal) => {
    client = await mcpClient(url, signal);
  });
  if (client === undefined) return checks;
  const mcp = client;
  await checkTools(checks, mcp);
  await mcp.close();

  const post = (signal: AbortSignal, { headers = {}, body }: { readonly headers?: Record<string, string>; readonly body: BodyInit }) =>
    fetch(url, { method: "POST", body, headers: { "Content-Type": "application/json", ...headers }, signal });
  const rejection = async (response: Response, status: number, code?: number) => {
    expectEqual(response.status, status, "status");
    expectEqual(response.headers.get("Cache-Control"), "no-store", "Cache-Control");
    if (code !== undefined) expectEqual(memberOf(memberOf(await readJson(response), "error"), "code"), code, "JSON-RPC error code");
  };

  await checks.run("a method other than POST is rejected with 405", `${RULE}#http`, async (signal) => {
    const response = await fetch(url, { signal });
    await rejection(response, 405);
    expectEqual(response.headers.get("Allow"), "POST", "Allow");
  });
  await checks.run("an origin that is not allowed is rejected with 403", `${RULE}#http`, async (signal) => {
    await rejection(await post(signal, { headers: { Origin: FORBIDDEN_ORIGIN }, body: "{}" }), 403);
  });
  await checks.run("a media type other than JSON is rejected with 415", `${RULE}#http`, async (signal) => {
    await rejection(await post(signal, { headers: { "Content-Type": "text/plain" }, body: "{}" }), 415);
  });
  await checks.run("a body over the limit is rejected with 413 and -32600", `${RULE}#http`, async (signal) => {
    await rejection(await post(signal, { body: " ".repeat(options.maximumBytes + 1) }), 413, -32600);
  });
  await checks.run("a body that is not JSON is rejected with 400 and -32700", `${RULE}#http`, async (signal) => {
    await rejection(await post(signal, { body: "{" }), 400, -32700);
  });
  await checks.run("a body that is not UTF-8 is rejected with 400", `${RULE}#http`, async (signal) => {
    await rejection(await post(signal, { body: new Uint8Array([0x7b, 0xff, 0x7d]) }), 400);
  });

  if (options.handshake) await checkHandshake(checks, url, options.deadline);
  return checks;
}

const ANCHOR = `${RULE}#earlier-revisions-through-http`;

/** The checks of the `initialize` handshake of revision 2025-11-25 (spec/bindings/mcp.md#earlier-revisions-through-http). */
async function checkHandshake(checks: Checks, url: string, deadline: number): Promise<void> {
  const handshakeChecks = new Checks("mcp 2025-11-25", deadline);
  let client: Client | undefined;
  await handshakeChecks.run("an MCP client connects with the initialize handshake of revision 2025-11-25", ANCHOR, async (signal) => {
    client = await mcpClient(url, signal, true);
    expectEqual(client.getNegotiatedProtocolVersion(), "2025-11-25", "the revision of the session");
  });
  if (client !== undefined) {
    await checkTools(handshakeChecks, client);
    await client.close();
  }

  const rpc = (signal: AbortSignal, message: object, version?: string) =>
    fetch(url, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", ...message }),
      headers: { "Content-Type": "application/json", ...(version === undefined ? {} : { "MCP-Protocol-Version": version }) },
      signal,
    });
  await handshakeChecks.run("initialize gives the revision of the client, and the server keeps no session", ANCHOR, async (signal) => {
    const response = await rpc(signal, { id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "acid-cat-conform", version: "0.1.0" } } });
    expectEqual(response.status, 200, "status");
    expectEqual(response.headers.get("Mcp-Session-Id"), null, "Mcp-Session-Id");
    expectEqual(memberOf(memberOf(await readJson(response), "result"), "protocolVersion"), "2025-11-25", "protocolVersion");
  });
  await handshakeChecks.run("a notification of a revision with a handshake gets 202", ANCHOR, async (signal) => {
    expectEqual((await rpc(signal, { method: "notifications/initialized" }, "2025-11-25")).status, 202, "status");
  });
  checks.results.push(...handshakeChecks.results);
}

/**
 * The checks of the tools and their outcomes, through a connected client (spec/bindings/mcp.md#tools). Each transport
 * runs them.
 */
export async function checkTools(checks: Checks, mcp: Client): Promise<void> {
  const call = (signal: AbortSignal, name: string, args: Record<string, unknown>) =>
    mcp.callTool({ name, arguments: args }, { signal });

  await checks.run("the instructions are the description of the catalog", `${RULE}#server`, () => {
    expectEqual(mcp.getInstructions(), fixture.description, "instructions");
  });

  await checks.run("tools/list gives each available capability of the view", `${RULE}#tools`, async (signal) => {
    const { tools } = await mcp.listTools(undefined, { signal });
    expectEqual(sorted(tools.map((tool) => tool.name)), idsOf("mcp"), "tools");
  });

  await checks.run("tools have their hints and output schemas", `${RULE}#tools`, async (signal) => {
    const { tools } = await mcp.listTools(undefined, { signal });
    const echo = tools.find((tool) => tool.name === "fixture.echo");
    const refuse = tools.find((tool) => tool.name === "fixture.refuse");
    expect(echo?.annotations?.readOnlyHint === true, "fixture.echo must have readOnlyHint: true");
    expect(refuse?.annotations?.readOnlyHint !== true, "fixture.refuse must not have readOnlyHint: true");
    expect(echo?.outputSchema?.type === "object", "fixture.echo must have an object outputSchema");
    expect(refuse?.outputSchema === undefined, "fixture.refuse has no object output, so it must have no outputSchema");
    expect(echo?.inputSchema.type === "object", "an inputSchema must be an object");
  });

  await checks.run("a value is a tool result with structured content", `${RULE}#tools`, async (signal) => {
    const result = await call(signal, "fixture.echo", { text: "hello" });
    expect(result.isError !== true, "a value must not be an error result");
    expectEqual(result.structuredContent, { text: "hello" }, "structuredContent");
    expectEqual(textOf(result), { text: "hello" }, "text content");
  });

  await checks.run("a failure is an error result with ok: false", `${RULE}#tools`, async (signal) => {
    const result = await call(signal, "fixture.refuse", {});
    expect(result.isError === true, "a failure must be an error result");
    const body = textOf(result);
    expect(memberOf(body, "ok") === false && memberOf(memberOf(body, "error"), "_tag") === "Refused", `expected { ok: false, error: { _tag: "Refused" } }, got ${JSON.stringify(body)}`);
  });

  await checks.run("a defect is an internal call failure with no internal details", `${RULE}#tools`, async (signal) => {
    const result = await call(signal, "fixture.crash", {});
    const body = textOf(result);
    expect(isObject(body), `expected an object, got ${JSON.stringify(body)}`);
    expect(result.isError === true && body.kind === "internal" && !("ok" in body), `expected { kind: "internal" }, got ${JSON.stringify(body)}`);
    const message = typeof body.message === "string" ? body.message : "";
    expect(!/\n\s+at /.test(message), "the message must not contain a stack trace");
  });

  await checks.run("an input that does not agree with its schema is invalid-input", `${RULE}#tools`, async (signal) => {
    const result = await call(signal, "fixture.echo", { text: 1 });
    expectEqual(memberOf(textOf(result), "kind"), "invalid-input", "kind");
  });

  await checks.run("a capability outside the view is an unknown tool", `${RULE}#tools`, async (signal) => {
    const error = await call(signal, "fixture.hidden", {}).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(memberOf(error, "code") === -32602, `expected the JSON-RPC error -32602, got ${JSON.stringify(error)}`);
  });

  await checks.run("an unavailable capability is not listed", `${RULE}#tools`, async (signal) => {
    await call(signal, "fixture.switch.set", { on: false });
    try {
      const { tools } = await mcp.listTools(undefined, { signal });
      expect(!tools.some((tool) => tool.name === "fixture.toggle"), "fixture.toggle must not be listed while it is unavailable");
    } finally {
      await call(AbortSignal.timeout(checks.deadline), "fixture.switch.set", { on: true });
    }
  });
}
