import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect, Exit, Scope, Stream } from "effect";

import { Http } from "../src/index.ts";
import { occurrences } from "../src/internal/httpClient.ts";
import * as NodeServer from "../src/NodeServer.ts";
import { runWith } from "./run.ts";

const remoteCli = new URL("./fixture-cli-remote.ts", import.meta.url).pathname;
const TOKEN = "Bearer secret-token-of-the-test";

/** Serve a handler until the test ends, and give its base URL. */
async function serve(handler: NodeServer.WebHandler): Promise<{ readonly url: string; readonly close: () => Promise<void> }> {
  const scope = Effect.runSync(Scope.make());
  const { url } = await Effect.runPromise(NodeServer.serve(handler, { port: 0 }).pipe(Scope.provide(scope)));
  return { url, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
}

/** The base URL of a server that does not answer: the port of a server that closed. */
async function closedUrl(): Promise<string> {
  const server = await serve(() => new Response(null, { status: 204 }));
  await server.close();
  return server.url;
}

/** A stream of the chunks of a text, as bytes. */
const bytes = (...chunks: string[]) => Stream.fromIterable(chunks.map((chunk) => new TextEncoder().encode(chunk)));

const occurrence = (eventId: string) => ({ eventId, name: "fixture.watch", timestamp: "2026-01-01T00:00:00.000Z", data: { value: eventId } });

test("a server that does not answer gives unavailable", async () => {
  const client = Http.client(await closedUrl());
  const outcome = await Effect.runPromise(client.invoke("fixture.echo", {}));
  assert.equal("kind" in outcome && outcome.kind, "unavailable");
  const listed = await Effect.runPromise(Effect.flip(client.capabilities));
  assert.equal(listed.kind, "unavailable");
  const subscribed = await Effect.runPromise(Effect.scoped(Effect.flip(client.subscribe("fixture.watch", {}))));
  assert.equal(subscribed.kind, "unavailable");
});

test("an answer that the HTTP binding does not give is internal", async (context) => {
  const server = await serve((request) => {
    const path = new URL(request.url).pathname;
    if (path === "/not-json/capabilities/fixture.echo") return new Response("<html></html>", { status: 200 });
    if (path === "/no-ok/capabilities/fixture.echo") return Response.json({ value: 1 });
    if (path === "/bad-failure/capabilities/fixture.echo") return Response.json({ kind: "teapot", message: "no" }, { status: 418 });
    if (path === "/not-a-list/capabilities") return Response.json({ id: "fixture.echo" });
    // A stream that ends before `complete`.
    if (path === "/cut/events/fixture.watch") return new Response(`event: next\ndata: ${JSON.stringify(occurrence("1"))}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    return new Response(null, { status: 404 });
  });
  context.after(server.close);
  for (const base of ["not-json", "no-ok", "bad-failure"]) {
    const outcome = await Effect.runPromise(Http.client(`${server.url}/${base}`).invoke("fixture.echo", {}));
    assert.equal("kind" in outcome && outcome.kind, "internal", base);
  }
  assert.equal((await Effect.runPromise(Effect.flip(Http.client(`${server.url}/not-a-list`).capabilities))).kind, "internal");
  const cut = await Effect.runPromise(
    Effect.scoped(Effect.flatMap(Http.client(`${server.url}/cut`).subscribe("fixture.watch", {}), (stream) => Stream.runCollect(stream).pipe(Effect.result))),
  );
  assert.equal(cut._tag === "Failure" && cut.failure.kind, "internal");
});

test("the client sends its headers and the cursor, and gives the call failure of the server", async (context) => {
  const seen: { authorization: string | null; lastEventId: string | null; query: string }[] = [];
  const server = await serve((request) => {
    const url = new URL(request.url);
    seen.push({ authorization: request.headers.get("Authorization"), lastEventId: request.headers.get("Last-Event-ID"), query: url.search });
    if (url.pathname === "/api/capabilities") return Response.json([{ id: "fixture.echo", available: true }, { id: "fixture.toggle", available: false, reason: "off" }]);
    if (url.pathname === "/api/capabilities/fixture.echo") return Response.json({ ok: true, value: { echoed: true } });
    if (url.pathname === "/api/events/fixture.watch") return Response.json({ kind: "invalid-input", message: "No." }, { status: 422 });
    return new Response(null, { status: 404 });
  });
  context.after(server.close);
  const client = Http.client(`${server.url}/api/`, { headers: { Authorization: TOKEN } });
  assert.equal(client.base, `${server.url}/api`);
  assert.deepEqual(await Effect.runPromise(client.invoke("fixture.echo", {})), { ok: true, value: { echoed: true } });
  assert.deepEqual(await Effect.runPromise(client.capabilities), [
    { id: "fixture.echo", available: true },
    { id: "fixture.toggle", available: false, reason: "off" },
  ]);
  const failure = await Effect.runPromise(Effect.scoped(Effect.flip(client.subscribe("fixture.watch", {}, { cursor: "c-7", maxAgeMs: 1000 }))));
  assert.deepEqual({ kind: failure.kind, message: failure.message }, { kind: "invalid-input", message: "No." });
  assert.ok(seen.every((each) => each.authorization === TOKEN));
  assert.deepEqual(seen.at(-1), { authorization: TOKEN, lastEventId: "c-7", query: "?maxAgeMs=1000" });
});

test("a base that is not an http URL, or a header that is not valid, throws with no header value in the message", () => {
  assert.throws(() => Http.client("ftp://example.com"), /not an http or https URL/);
  assert.throws(() => Http.client("not a url"), /not a URL/);
  assert.throws(
    () => Http.client("http://example.com", { headers: { Authorization: "Bearer a\nb" } }),
    (error: unknown) => error instanceof Error && error.message.includes("Authorization") && !error.message.includes("Bearer"),
  );
});

test("the reader of server-sent events reads comments, line ends, split chunks and lines of data", async () => {
  const first = JSON.stringify(occurrence("1"));
  const second = JSON.stringify(occurrence("2"));
  const read = await Effect.runPromise(
    Stream.runCollect(
      occurrences(
        bytes(
          ":\n\n",
          "retry: 10\nevent: other\ndata: x\n\n",
          `event: next\r\nid: 1\r\ndata: ${first.slice(0, 10)}`,
          `${first.slice(10)}\r\n\r\n`,
          // One occurrence in two lines of data: the reader joins them with a line feed, which is JSON white space.
          `event:next\rdata:${second.slice(0, second.indexOf(",") + 1)}\rdata: ${second.slice(second.indexOf(",") + 1)}\r\r`,
          "event: complete\ndata:\n\n",
          "event: next\ndata: not read\n\n",
        ),
      ),
    ),
  );
  assert.deepEqual(read, [occurrence("1"), occurrence("2")]);

  const failed = await Effect.runPromise(
    Stream.runCollect(occurrences(bytes(`event: next\ndata: ${first}\n\nevent: error\ndata: {"kind":"internal","message":"The provider failed."}\n\n`))).pipe(Effect.result),
  );
  assert.equal(failed._tag === "Failure" && failed.failure.message, "The provider failed.");

  const notAnOccurrence = await Effect.runPromise(Stream.runCollect(occurrences(bytes('event: next\ndata: {"a":1}\n\n'))).pipe(Effect.result));
  assert.equal(notAnOccurrence._tag === "Failure" && notAnOccurrence.failure.kind, "internal");
});

test("the command line that calls a server never writes its headers", async (context) => {
  const down = await closedUrl();
  const garbage = await serve(() => new Response("not the HTTP binding", { status: 200 }));
  context.after(garbage.close);
  const withToken = (url: string, ...args: string[]) => runWith({ FIXTURE_AUTHORIZATION: TOKEN }, remoteCli, url, ...args);
  const [unavailable, internal, list] = await Promise.all([
    withToken(down, "fixture", "echo", "--text", "hi"),
    withToken(garbage.url, "fixture", "echo", "--text", "hi"),
    withToken(down, "list"),
  ]);
  assert.equal(unavailable.code, 4);
  assert.partialDeepStrictEqual(JSON.parse(unavailable.stderr), { kind: "unavailable" });
  assert.equal(internal.code, 5);
  assert.partialDeepStrictEqual(JSON.parse(internal.stderr), { kind: "internal" });
  assert.equal(list.code, 4);
  for (const result of [unavailable, internal, list]) {
    assert.ok(!`${result.stdout}${result.stderr}`.includes("secret-token"), `${result.stdout}${result.stderr}`);
  }
});
