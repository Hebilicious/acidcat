/** A small MCP client of revision 2026-07-28 for the tests of the events extension. */
import { Schema } from "effect";

export const ORIGIN = "https://fixture.example";

/** A JSON-RPC message, with the members that the tests read. */
export const Message = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number, Schema.Null])),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  result: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  error: Schema.optional(Schema.Struct({ code: Schema.Number, message: Schema.String, data: Schema.optional(Schema.Unknown) })),
});
export type Message = typeof Message.Type;
export const decodeMessage = (text: string): Message => Schema.decodeUnknownSync(Schema.fromJsonString(Message))(text);

export const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };

/** One MCP request of revision 2026-07-28 through HTTP, with the headers of the revision. */
export function mcpRequest(method: string, params: Record<string, unknown> = {}, init: { readonly id?: string | number; readonly headers?: Record<string, string> } = {}) {
  const headers = new Headers({
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "Mcp-Method": method,
    "MCP-Protocol-Version": "2026-07-28",
    ...init.headers,
  });
  if (typeof params.name === "string") headers.set("Mcp-Name", params.name);
  return new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: init.id ?? 1, method, params: { ...params, _meta: meta } }),
  });
}

export const json = async (response: Response) => decodeMessage(await response.text());

/** The result of a poll. */
export const PollResult = Schema.Struct({
  resultType: Schema.Literal("complete"),
  events: Schema.Array(
    Schema.Struct({ eventId: Schema.String, name: Schema.String, timestamp: Schema.String, data: Schema.Unknown, cursor: Schema.optionalKey(Schema.String) }),
  ),
  cursor: Schema.String,
  truncated: Schema.Boolean,
  hasMore: Schema.Boolean,
  nextPollMs: Schema.Number,
});
export type PollResult = typeof PollResult.Type;
export const decodePollResult = Schema.decodeUnknownSync(PollResult);

/** Wait a number of milliseconds. */
export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Run `attempt` until `done` holds for its result, and give that result. Fail after about two seconds. */
export async function eventually<A>(attempt: () => Promise<A>, done: (value: A) => boolean, what = "the condition"): Promise<A> {
  for (let tries = 0; tries < 200; tries += 1) {
    const value = await attempt();
    if (done(value)) return value;
    await delay(10);
  }
  throw new Error(`Timed out while waiting for ${what}.`);
}
