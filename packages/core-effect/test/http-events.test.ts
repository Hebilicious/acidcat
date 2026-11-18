import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect, Exit, Schema, Scope } from "effect";

import { Http } from "../src/index.ts";
import * as NodeServer from "../src/NodeServer.ts";
import { events, feedForPromises } from "./events-fixture.ts";

const ORIGIN = "https://fixture.example";

function setup(options: Partial<Http.Options> = {}) {
  const feed = feedForPromises();
  const handler = Http.toWebHandler(events, feed.layer, { allowedOrigins: [ORIGIN], base: "/api", ...options });
  const subscribe = (id: string, body: unknown, init: { readonly headers?: Record<string, string>; readonly query?: string; readonly signal?: AbortSignal } = {}) =>
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

function messagesOf(response: Response) {
  assert.ok(response.body);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  return {
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

test("POST /events/{id} with a body that is not JSON is invalid-input, and the screening rejects another method or origin", async () => {
  const { subscribe, handler } = setup();
  const notJson = await handler(new Request(`${ORIGIN}/api/events/feed.ticked`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }));
  assert.equal(notJson.status, 422);
  assert.equal((await handler(new Request(`${ORIGIN}/api/events/feed.ticked`, { method: "PUT" }))).status, 405);
  assert.equal((await subscribe("feed.ticked", {}, { headers: { Origin: "https://evil.example" } })).status, 403);
});

test("an unknown id comes before a maxAgeMs that is not valid, and before a body that is not JSON", async () => {
  const { subscribe, handler } = setup();
  assert.equal((await subscribe("no.such", {}, { query: "?maxAgeMs=-1" })).status, 404);
  assert.equal((await subscribe("feed.hidden", {}, { query: "?maxAgeMs=abc" })).status, 404);
  const notJson = await handler(new Request(`${ORIGIN}/api/events/no.such`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "nope" }));
  assert.equal(notJson.status, 404);
  for (const maxAgeMs of ["-1", "1.5", "abc", "", "01"]) {
    assert.equal((await subscribe("feed.resumed", {}, { query: `?maxAgeMs=${maxAgeMs}` })).status, 422, `maxAgeMs=${maxAgeMs}`);
  }
});

test("Last-Event-ID gives the cursor, maxAgeMs gives maxAgeMs, and the id of a message is the cursor", async () => {
  const { subscribe } = setup();
  const response = await subscribe("feed.resumed", {}, { headers: { "Last-Event-ID": "before" }, query: "?maxAgeMs=60000" });
  const fields = fieldsOf(await messagesOf(response).next());
  assert.equal(fields.id, "after");
  assert.deepEqual(occurrenceIn(fields).data, { cursor: "before", maxAgeMs: 60000 });
});

test("a stream with no message for the keepalive time gets a comment line", async () => {
  const { subscribe } = setup({ keepaliveMs: 20 });
  const response = await subscribe("feed.ticked", {});
  const messages = messagesOf(response);
  assert.equal(await messages.next(), ":");
  await messages.cancel();
});

test("with per-request services, a subscription through a Node.js server gets occurrences until the client closes it", async () => {
  const { feed, handler } = setup({ services: "per-request" });
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
