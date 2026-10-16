/**
 * Conformance checks for the MCP binding (spec/bindings/mcp.md). The protocol checks use the official MCP client,
 * with revision 2026-07-28. The rejection checks send requests that a client never sends.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { Checks, expect, expectEqual, fixture, FORBIDDEN_ORIGIN, idsOf, sorted } from "./check.ts";

const RULE = "spec/bindings/mcp.md";

type ToolResult = {
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
};

/** A connected MCP client. */
export async function mcpClient(url: string, signal?: AbortSignal): Promise<Client> {
  const client = new Client({ name: "acid-cat-conform", version: "0.1.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)), signal ? { signal } : undefined);
  return client;
}

const textOf = (result: ToolResult): unknown => JSON.parse(result.content?.[0]?.text ?? "null");

export async function checkMcp(url: string, options: { readonly maximumBytes: number; readonly deadline: number }): Promise<Checks> {
  const checks = new Checks("mcp", options.deadline);
  let client: Client | undefined;

  await checks.run("an MCP client connects with revision 2026-07-28", `${RULE}#server`, async (signal) => {
    client = await mcpClient(url, signal);
  });
  if (client === undefined) return checks;
  const mcp = client;
  const call = (signal: AbortSignal | undefined, name: string, args: Record<string, unknown>) =>
    mcp.callTool({ name, arguments: args }, signal ? { signal } : undefined) as Promise<ToolResult>;

  await checks.run("server/discover gives the description of the catalog as instructions", `${RULE}#server`, () => {
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
    expect((echo?.outputSchema as { type?: string } | undefined)?.type === "object", "fixture.echo must have an object outputSchema");
    expect(refuse?.outputSchema === undefined, "fixture.refuse has no object output, so it must have no outputSchema");
    expect((echo?.inputSchema as { type?: string }).type === "object", "an inputSchema must be an object");
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
    const body = textOf(result) as { ok?: boolean; error?: { _tag?: string } };
    expect(body.ok === false && body.error?._tag === "Refused", `expected { ok: false, error: { _tag: "Refused" } }, got ${JSON.stringify(body)}`);
  });

  await checks.run("a defect is an internal call failure with no internal details", `${RULE}#tools`, async (signal) => {
    const result = await call(signal, "fixture.crash", {});
    const body = textOf(result) as { kind?: string; message?: string; ok?: unknown };
    expect(result.isError === true && body.kind === "internal" && !("ok" in body), `expected { kind: "internal" }, got ${JSON.stringify(body)}`);
    expect(!/\n\s+at /.test(body.message ?? ""), "the message must not contain a stack trace");
  });

  await checks.run("an input that does not agree with its schema is invalid-input", `${RULE}#tools`, async (signal) => {
    const result = await call(signal, "fixture.echo", { text: 1 });
    expectEqual((textOf(result) as { kind?: string }).kind, "invalid-input", "kind");
  });

  await checks.run("a capability outside the view is an unknown tool", `${RULE}#tools`, async (signal) => {
    const error = await call(signal, "fixture.hidden", {}).then(
      () => undefined,
      (caught: { code?: number }) => caught,
    );
    expect(error?.code === -32602, `expected the JSON-RPC error -32602, got ${JSON.stringify(error)}`);
  });

  await checks.run("an unavailable capability is not listed", `${RULE}#tools`, async (signal) => {
    await call(signal, "fixture.switch.set", { on: false });
    try {
      const { tools } = await mcp.listTools(undefined, { signal });
      expect(!tools.some((tool) => tool.name === "fixture.toggle"), "fixture.toggle must not be listed while it is unavailable");
    } finally {
      await call(undefined, "fixture.switch.set", { on: true });
    }
  });

  await mcp.close();

  const post = (signal: AbortSignal, init: RequestInit & { headers?: Record<string, string> }) =>
    fetch(url, { method: "POST", ...init, headers: { "Content-Type": "application/json", ...init.headers }, signal });
  const rejection = async (response: Response, status: number, code?: number) => {
    expectEqual(response.status, status, "status");
    expectEqual(response.headers.get("Cache-Control"), "no-store", "Cache-Control");
    if (code !== undefined) expectEqual(((await response.json()) as { error?: { code?: number } }).error?.code, code, "JSON-RPC error code");
  };

  await checks.run("a method other than POST is rejected with 405", `${RULE}#server`, async (signal) => {
    const response = await fetch(url, { signal });
    await rejection(response, 405);
    expectEqual(response.headers.get("Allow"), "POST", "Allow");
  });
  await checks.run("an origin that is not allowed is rejected with 403", `${RULE}#server`, async (signal) => {
    await rejection(await post(signal, { headers: { Origin: FORBIDDEN_ORIGIN }, body: "{}" }), 403);
  });
  await checks.run("a media type other than JSON is rejected with 415", `${RULE}#server`, async (signal) => {
    await rejection(await post(signal, { headers: { "Content-Type": "text/plain" }, body: "{}" }), 415);
  });
  await checks.run("a body over the limit is rejected with 413 and -32600", `${RULE}#server`, async (signal) => {
    await rejection(await post(signal, { body: " ".repeat(options.maximumBytes + 1) }), 413, -32600);
  });
  await checks.run("a body that is not JSON is rejected with 400 and -32700", `${RULE}#server`, async (signal) => {
    await rejection(await post(signal, { body: "{" }), 400, -32700);
  });
  await checks.run("a body that is not UTF-8 is rejected with 400", `${RULE}#server`, async (signal) => {
    await rejection(await post(signal, { body: new Uint8Array([0x7b, 0xff, 0x7d]) }), 400);
  });

  return checks;
}
