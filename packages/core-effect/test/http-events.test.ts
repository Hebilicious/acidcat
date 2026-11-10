import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect, Exit, Schema, Scope } from "effect";

import { Http } from "../src/index.ts";
import * as NodeServer from "../src/NodeServer.ts";
import { decodeBody } from "./decode.ts";
import { events, feedForPromises } from "./events-fixture.ts";

const ORIGIN = "https://fixture.example";

/** A handler for the fixture, with its own feed. */
function setup(options: Partial<Http.Options> = {}) {
  const feed = feedForPromises();
  const handler = Http.toWebHandler(events, feed.layer, { allowedOrigins: [ORIGIN], base: "/api", ...options });
  const subscribe = (id: string, body: unknown, init: { readonly headers?: HeadersInit; readonly query?: string; readonly signal?: AbortSignal } = {}) =>
    handler(
      new Request(`${ORIGIN}/api/events/${id}${init.query ?? ""}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...init.headers },
        body: JSON.stringify(body),
        ...(init.signal === undefined ? {} : { signal: init.signal }),
      }),
    );
  return { feed, handler, subscribe };
}

/** A reader of the server-sent events of a response, one message at a time. */
function messagesOf(response: Response) {
  assert.ok(response.body);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  return {
    /** The next message, as its text without the blank line that ends it, or `undefined` when the stream ends. */
    next: async (): Promise<string | undefined> => {
      for (;;) {
        const end = buffered.indexOf("\n\n");
        if (end >= 0) {
          const message = buffered.slice(0, end);
          buffered = buffered.slice(end + 2);
          return message;
        }
        const chunk = await reader.read();
        if (chunk.done) return undefined;
        buffered += chunk.value;
      }
    },
    cancel: () => reader.cancel(),
  };
}

/** The fields of one message: `event`, `id` and `data`. */
function fieldsOf(message: string | undefined) {
  assert.ok(message !== undefined, "the stream has a message");
  const fields: Record<string, string> = {};
  for (const line of message.split("\n")) {
    const colon = line.indexOf(":");
    const name = line.slice(0, colon);
    fields[name] = line.slice(colon + 1).trimStart();
  }
  return fields;
}

const OccurrenceShape = Schema.Struct({
  eventId: Schema.String,
  name: Schema.String,
  timestamp: Schema.String,
  data: Schema.Unknown,
  cursor: Schema.optionalKey(Schema.String),
  truncated: Schema.optionalKey(Schema.Literal(true)),
});
const occurrenceIn = (fields: Record<string, string>) => Schema.decodeUnknownSync(Schema.fromJsonString(OccurrenceShape))(fields.data);

test("GET /events lists the events of the view", async () => {
  const { handler } = setup();
  const list = await decodeBody(Schema.Array(Schema.Struct({ id: Schema.String })), await handler(new Request(`${ORIGIN}/api/events`)));
  assert.deepEqual(list.map(({ id }) => id).sort(), ["feed.counted", "feed.crashing", "feed.disagreeing", "feed.resumed", "feed.ticked", "feed.timed"]);
});

test("a subscription that cannot start is a JSON call failure with its status", async () => {
  const { subscribe, handler } = setup();
  const failure = async (response: Response) => ({ status: response.status, body: await response.json() });
  assert.deepEqual(await failure(await subscribe("feed.hidden", {})), {
    status: 404,
    body: { kind: "unknown-capability", message: "There is no event feed.hidden." },
  });
  assert.equal((await subscribe("feed.publish", {})).status, 404);
  assert.equal((await subscribe("feed.ticked", { room: 1 })).status, 422);
  assert.equal((await subscribe("feed.ticked", {}, { query: "?maxAgeMs=-1" })).status, 422);
  const notJson = await handler(new Request(`${ORIGIN}/api/events/feed.ticked`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }));
  assert.equal(notJson.status, 422);
  assert.equal((await handler(new Request(`${ORIGIN}/api/events/feed.ticked`, { method: "PUT" }))).status, 405);
  const origin = await subscribe("feed.ticked", {}, { headers: { Origin: "https://evil.example" } });
  assert.equal(origin.status, 403);
});

test("a subscription is a stream of server-sent events: next for each occurrence, then complete", async () => {
  const { subscribe } = setup();
  const response = await subscribe("feed.counted", { a: 1, b: 2 });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/event-stream");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const messages = messagesOf(response);
  const first = fieldsOf(await messages.next());
  assert.equal(first.event, "next");
  assert.deepEqual(occurrenceIn(first).data, { key: "a", value: 1 });
  assert.equal(occurrenceIn(first).eventId, "a");
  assert.deepEqual(occurrenceIn(fieldsOf(await messages.next())).data, { key: "b", value: 2 });
  assert.deepEqual(fieldsOf(await messages.next()), { event: "complete", data: "" });
  assert.equal(await messages.next(), undefined);
});

test("Last-Event-ID gives the cursor, maxAgeMs gives maxAgeMs, and the id of a message is the cursor", async () => {
  const { subscribe } = setup();
  const response = await subscribe("feed.resumed", {}, { headers: { "Last-Event-ID": "before" }, query: "?maxAgeMs=60000" });
  const fields = fieldsOf(await messagesOf(response).next());
  assert.equal(fields.id, "after");
  assert.deepEqual(occurrenceIn(fields).data, { cursor: "before", maxAgeMs: 60000 });
});

test("a failure of the provider is an error message with internal, after the occurrences before it", async () => {
  const { subscribe } = setup();
  const messages = messagesOf(await subscribe("feed.crashing", {}));
  assert.equal(fieldsOf(await messages.next()).event, "next");
  const error = fieldsOf(await messages.next());
  assert.equal(error.event, "error");
  assert.deepEqual(JSON.parse(error.data ?? ""), { kind: "internal", message: "The event failed." });
  assert.equal(await messages.next(), undefined);
});

test("a stream with no message for the keepalive time gets a comment line", async () => {
  const { subscribe } = setup({ keepaliveMs: 20 });
  const response = await subscribe("feed.ticked", {});
  const messages = messagesOf(response);
  assert.equal(await messages.next(), ":");
  await messages.cancel();
});

for (const services of ["shared", "per-request"] as const) {
  test(`with ${services} services, a subscription through a Node.js server gets occurrences until the client closes it`, async () => {
    const { feed, handler } = setup({ services });
    const scope = Effect.runSync(Scope.make());
    try {
      const served = await Effect.runPromise(NodeServer.serve({ "/api": handler }, { port: 0 }).pipe(Scope.provide(scope)));
      const controller = new AbortController();
      const response = await fetch(`${served.url}/api/events/feed.ticked`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room: "a" }),
        signal: controller.signal,
      });
      assert.equal(response.status, 200);
      const messages = messagesOf(response);
      await feed.following(1);
      await feed.publish({ room: "b", count: 1 });
      await feed.publish({ room: "a", count: 2 });
      const fields = fieldsOf(await messages.next());
      assert.equal(fields.id, "2");
      assert.deepEqual(occurrenceIn(fields).data, { room: "a", count: 2 });
      controller.abort();
      await feed.following(0);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  });
}
