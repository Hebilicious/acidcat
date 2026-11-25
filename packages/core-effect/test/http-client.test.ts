import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { Effect, Exit, Fiber, Option, Schema, Scope, Stream } from "effect";

import { Http } from "../src/index.ts";
import { occurrences } from "../src/internal/httpClient.ts";
import * as NodeServer from "../src/NodeServer.ts";
import { decodeText } from "./decode.ts";
import { events, feedForPromises } from "./events-fixture.ts";
import { runWith } from "./run.ts";
import { bundledProgram } from "./bundled-program.ts";

const remoteCli = bundledProgram("test/fixture-cli-remote.ts");
const WITHOUT_GRACE = fileURLToPath(new URL("../../../test-support/without-interrupt-grace.ts", import.meta.url));
const TOKEN = "Bearer secret-token-of-the-test";

async function serve(handler: NodeServer.WebHandler): Promise<{ readonly url: string; readonly close: () => Promise<void> }> {
  const scope = Effect.runSync(Scope.make());
  const { url } = await Effect.runPromise(NodeServer.serve(handler, { port: 0 }).pipe(Scope.provide(scope)));
  return { url, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
}

async function closedUrl(): Promise<string> {
  const server = await serve(() => new Response(null, { status: 204 }));
  await server.close();
  return server.url;
}

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

const badLists: Record<string, unknown> = {
  "no-reason": [{ id: "fixture.echo", available: true }, { id: "fixture.toggle", available: false }],
  "no-id": [{ available: true }],
  "not-boolean": [{ id: "fixture.echo", available: "yes" }],
  "reason-not-text": [{ id: "fixture.toggle", available: false, reason: 1 }],
};

test("an answer that the HTTP surface does not give is internal, also an item of GET /capabilities without an id, a boolean available, or a reason when it is not available", async (context) => {
  const server = await serve((request) => {
    const path = new URL(request.url).pathname;
    if (path === "/not-json/capabilities/fixture.echo") return new Response("<html></html>", { status: 200 });
    if (path === "/no-ok/capabilities/fixture.echo") return Response.json({ value: 1 });
    if (path === "/bad-failure/capabilities/fixture.echo") return Response.json({ kind: "teapot", message: "no" }, { status: 418 });
    if (path === "/not-a-list/capabilities") return Response.json({ id: "fixture.echo" });
    const list = badLists[path.split("/")[1] ?? ""];
    if (list !== undefined) return Response.json(list);
    if (path === "/cut/events/fixture.watch") return new Response(`event: next\ndata: ${JSON.stringify(occurrence("1"))}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    return new Response(null, { status: 404 });
  });
  context.after(server.close);
  for (const base of ["not-json", "no-ok", "bad-failure"]) {
    const outcome = await Effect.runPromise(Http.client(`${server.url}/${base}`).invoke("fixture.echo", {}));
    assert.equal("kind" in outcome && outcome.kind, "internal", base);
  }
  for (const base of ["not-a-list", ...Object.keys(badLists)]) {
    assert.equal((await Effect.runPromise(Effect.flip(Http.client(`${server.url}/${base}`).capabilities))).kind, "internal", base);
  }
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

test("a base that is not an http URL, that has credentials, a query or a fragment, or a header that is not valid, throws with no secret in the message", () => {
  assert.throws(() => Http.client("ftp://example.com"), /not an http or https URL/);
  assert.throws(() => Http.client("not a url"), /not a URL/);
  assert.throws(
    () => Http.client("http://example.com", { headers: { Authorization: "Bearer a\nb" } }),
    (error: unknown) => error instanceof Error && error.message.includes("Authorization") && !error.message.includes("Bearer"),
  );
  const credentials = (error: unknown) => error instanceof Error && /user name or a password\. Give them in a header/.test(error.message) && !error.message.includes("TOKEN");
  assert.throws(() => Http.client("http://user:TOKEN@example.com/cli"), credentials);
  assert.throws(() => Http.client("http://TOKEN@example.com/cli"), credentials);
  assert.throws(() => Http.client("http://example.com/cli?k=v"), /must not have a query or a fragment/);
  assert.throws(() => Http.client("http://example.com/cli#part"), /must not have a query or a fragment/);
  assert.throws(() => Http.client("not a url TOKEN"), (error: unknown) => error instanceof Error && !error.message.includes("TOKEN"));
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
          // Server-sent events join two lines of data with a line feed, which is JSON white space.
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
  const garbage = await serve(() => new Response("not the HTTP surface", { status: 200 }));
  context.after(garbage.close);
  const withToken = (url: string, ...args: string[]) => runWith(context, { FIXTURE_AUTHORIZATION: TOKEN }, remoteCli, url, ...args);
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

test("an interrupt before the server answers a subscription ends watch with 130, and writes nothing", async (context) => {
  let received: () => void = () => undefined;
  const subscribed = new Promise<void>((resolve) => (received = resolve));
  const closed = Promise.withResolvers<void>();
  const server = await serve(
    (request) =>
      new Promise<Response>(() => {
        request.signal.addEventListener("abort", () => closed.resolve());
        received();
      }),
  );
  context.after(server.close);
  const child = spawn(process.execPath, [remoteCli, server.url, "watch", "fixture.ticks", "--count", "1"], { stdio: ["ignore", "pipe", "pipe"] });
  context.after(() => child.kill("SIGKILL"));
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf-8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf-8").on("data", (chunk: string) => (stderr += chunk));
  const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
  await subscribed;
  child.kill("SIGINT");
  assert.equal(await exited, 130);
  assert.equal(stderr, "");
  assert.equal(stdout, "");
  await closed.promise;
});

test("an interrupt during a call or list of a server that does not answer is cancelled, with exit code 130", async (context) => {
  const requested = Promise.withResolvers<void>();
  const paths: string[] = [];
  const server = await serve(
    (request) =>
      new Promise<Response>(() => {
        paths.push(new URL(request.url).pathname);
        if (paths.length === 2) requested.resolve();
      }),
  );
  context.after(server.close);
  const interrupted = (...args: string[]) => {
    const child = spawn(process.execPath, ["--import", WITHOUT_GRACE, remoteCli, server.url, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    context.after(() => child.kill("SIGKILL"));
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf-8").on("data", (chunk: string) => (stderr += chunk));
    const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
    return { child, ended: exited.then((code) => ({ code, stdout, stderr })) };
  };
  const runs = [interrupted("fixture", "echo", "--text", "hi"), interrupted("list")];
  await requested.promise;
  assert.deepEqual(paths.sort(), ["/capabilities", "/capabilities/fixture.echo"]);
  for (const { child } of runs) child.kill("SIGINT");
  const cancelled = { code: 130, stdout: "", stderr: `${JSON.stringify({ kind: "cancelled", message: "The call was cancelled." })}\n` };
  assert.deepEqual(await Promise.all(runs.map(({ ended }) => ended)), [cancelled, cancelled]);
});

test("list marks a capability that the server does not list as unavailable", async (context) => {
  const server = await serve(() => Response.json([{ id: "fixture.echo", available: true }, { id: "fixture.toggle", available: false, reason: "Off." }]));
  context.after(server.close);
  const listed = await runWith(context, {}, remoteCli, server.url, "list");
  assert.equal(listed.code, 0, listed.stderr);
  const Entry = Schema.Struct({ id: Schema.String, available: Schema.optionalKey(Schema.Boolean), reason: Schema.optionalKey(Schema.String) });
  const entries = decodeText(Schema.Array(Entry), listed.stdout);
  const entry = (id: string) => entries.find((each) => each.id === id);
  assert.deepEqual(entry("fixture.echo")?.available, true);
  assert.deepEqual(entry("fixture.toggle")?.reason, "Off.");
  assert.deepEqual(entry("fixture.refuse")?.reason, "The server does not serve this capability.");
  assert.equal(entry("fixture.refuse")?.available, false);
});

test("a cursor that is not a header value is invalid-input, and the client sends no request", async (context) => {
  let requests = 0;
  const server = await serve(() => {
    requests += 1;
    return new Response(null, { status: 404 });
  });
  context.after(server.close);
  const client = Http.client(server.url);
  for (const cursor of ["a→b", "a\nb", "a\rb", "a\0b"]) {
    const failure = await Effect.runPromise(Effect.scoped(Effect.flip(client.subscribe("fixture.watch", {}, { cursor }))));
    assert.equal(failure.kind, "invalid-input", JSON.stringify(cursor));
  }
  assert.equal(requests, 0);
  const watched = await runWith(context, {}, remoteCli, server.url, "watch", "fixture.ticks", "--count", "1", "--cursor", "a→b");
  assert.equal(watched.code, 3, watched.stderr);
  assert.partialDeepStrictEqual(JSON.parse(watched.stderr), { kind: "invalid-input" });
  assert.equal(requests, 0);
});

test("a 200 answer to a subscription that is not a stream of server-sent events is internal at once", async (context) => {
  const closed = Promise.withResolvers<void>();
  const server = await serve(() => {
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => controller.enqueue(new TextEncoder().encode("{")),
      cancel: () => closed.resolve(),
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
  });
  context.after(server.close);
  const failure = await Effect.runPromise(Effect.scoped(Effect.flip(Http.client(server.url).subscribe("fixture.watch", {}))), { signal: context.signal });
  assert.equal(failure.kind, "internal");
  await closed.promise;
});

test("a client with the Undici layer of a socket path reaches a server on a Unix socket, and a missing socket is unavailable", async (context) => {
  const folder = await mkdtemp(join(tmpdir(), "acid-cat-"));
  context.after(() => rm(folder, { recursive: true, force: true }));
  const path = join(folder, "server.sock");
  const feed = feedForPromises();
  const handler = Http.toWebHandler(events, feed.layer, { allowedOrigins: [], base: "/api" });
  const scope = Effect.runSync(Scope.make());
  context.after(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const served = await Effect.runPromise(NodeServer.serve({ "/api": handler }, { path }).pipe(Scope.provide(scope)));
  assert.deepEqual(served, { url: "http://localhost", path });
  const client = Http.client(`${served.url}/api`, { layer: NodeHttpClient.layerUndiciOptions({ connect: { socketPath: path } }) });

  const listed = await Effect.runPromise(client.capabilities);
  assert.deepEqual(listed, [{ id: "feed.publish", available: true }]);
  assert.deepEqual(await Effect.runPromise(client.invoke("feed.publish", { room: "hall", count: 0 })), { ok: true, value: null });
  const first = Effect.scoped(
    Effect.gen(function* () {
      const stream = yield* client.subscribe("feed.ticked", {});
      const taken = yield* Effect.forkScoped(Stream.runHead(stream));
      yield* Effect.promise(() => feed.following(1));
      yield* Effect.promise(() => feed.publish({ room: "hall", count: 1 }));
      return yield* Fiber.join(taken);
    }),
  );
  assert.deepEqual(Option.getOrThrow(await Effect.runPromise(first, { signal: context.signal })).data, { room: "hall", count: 1 });
  await feed.following(0);

  const missing = Http.client("http://localhost/api", { layer: NodeHttpClient.layerUndiciOptions({ connect: { socketPath: join(folder, "missing.sock") } }) });
  assert.equal((await Effect.runPromise(Effect.flip(missing.capabilities))).kind, "unavailable");
});
