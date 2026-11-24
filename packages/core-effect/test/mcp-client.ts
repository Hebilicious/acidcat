import { Schema } from "effect";

export const ORIGIN = "https://fixture.example";

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

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The test timeout stops a wait that does not end. */
export async function eventually<A>(attempt: () => Promise<A>, done: (value: A) => boolean): Promise<A> {
  for (;;) {
    const value = await attempt();
    if (done(value)) return value;
    await delay(10);
  }
}
