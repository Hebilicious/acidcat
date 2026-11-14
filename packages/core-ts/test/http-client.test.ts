import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { httpClient, httpHandler, runCli } from "../src/index.ts";
import type { CliOptions, HttpClient } from "../src/index.ts";
import { SseParser } from "../src/http-client.ts";
import { serve } from "../src/node.ts";
import type { WebHandler } from "../src/node.ts";
import { fixture, options } from "./fixture.ts";
import type { Context } from "./fixture.ts";

/** A token that the tests send in a header. No output may contain it. */
const SECRET = "Bearer s3cr3t-t0k3n";

/** Run the command line of the fixture with a remote client, and give its exit code and its output. */
async function remoteCli(remote: HttpClient, args: readonly string[], signal?: AbortSignal) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const cliOptions: CliOptions<Context> = { name: "fixture", version: "0.0.0", ...options(), remote };
  const code = await runCli(fixture, cliOptions, args, { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text), signal });
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

/** The kind of the call failure on standard error. */
const kindOf = (stderr: string): unknown => {
  const parsed: unknown = JSON.parse(stderr);
  return typeof parsed === "object" && parsed !== null && "kind" in parsed ? parsed.kind : undefined;
};

/** Serve a handler on a free port for the time of a test. */
async function served(handler: WebHandler, context: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const server = await serve(handler, { port: 0 });
  context.after(() => server.close());
  return server.url;
}

describe("the command line that calls a server", () => {
  test("a server that does not answer is unavailable, with exit code 4, and the header is not written", async () => {
    // A port that was free a moment ago: nothing listens on it.
    const server = await serve(() => new Response(null), { port: 0 });
    await server.close();
    const remote = httpClient(server.url, { headers: { Authorization: SECRET } });
    for (const args of [["fixture", "echo", "--text", "hi"], ["call", "fixture.echo", '{"text":"hi"}'], ["list"], ["watch", "fixture.ticks", "--count", "1"]]) {
      const run = await remoteCli(remote, args);
      assert.equal(run.code, 4, args.join(" "));
      assert.equal(kindOf(run.stderr), "unavailable");
      assert.equal(run.stdout, "");
      assert.ok(!run.stderr.includes("s3cr3t"), "the header is not on standard error");
    }
  });

  test("an answer that the HTTP binding does not give is internal, with exit code 5", async (context) => {
    const answers: readonly (() => Response)[] = [
      () => new Response("<html>Not an API</html>", { status: 200, headers: { "Content-Type": "text/html" } }),
      () => new Response(JSON.stringify({ hello: "world" }), { status: 200, headers: { "Content-Type": "application/json" } }),
      () => new Response("Bad gateway", { status: 502 }),
      () => new Response(JSON.stringify({ kind: "teapot", message: "Not a kind." }), { status: 400 }),
    ];
    for (const answer of answers) {
      const url = await served(answer, context);
      const remote = httpClient(url);
      for (const args of [["fixture", "echo", "--text", "hi"], ["list"], ["watch", "fixture.ticks", "--count", "1"]]) {
        const run = await remoteCli(remote, args);
        assert.equal(run.code, 5, `${args.join(" ")} with ${url}`);
        assert.equal(kindOf(run.stderr), "internal");
      }
    }
  });

  test("a stream with an occurrence that is not valid, or that ends with no complete, ends as internal", async (context) => {
    const streams = ["event: next\ndata: {\"not\":\"an occurrence\"}\n\n", ": only a comment\n\n"];
    for (const stream of streams) {
      const url = await served(() => new Response(stream, { headers: { "Content-Type": "text/event-stream" } }), context);
      const run = await remoteCli(httpClient(url), ["watch", "fixture.ticks", "--count", "1"]);
      assert.equal(run.code, 5);
      assert.equal(kindOf(run.stderr), "internal");
    }
  });

  test("the client sends the headers, a call failure of the server keeps its kind, and the header is never written", async (context) => {
    const seen: (string | null)[] = [];
    const http = httpHandler(fixture, { allowedOrigins: [], target: "cli", ...options() });
    const url = await served((request) => {
      seen.push(request.headers.get("Authorization"));
      return http(request);
    }, context);
    const remote = httpClient(`${url}/`, { headers: { Authorization: SECRET } });
    assert.equal(remote.base, url);
    const echo = await remoteCli(remote, ["fixture", "echo", "--text", "hi"]);
    assert.equal(echo.code, 0);
    assert.deepEqual(JSON.parse(echo.stdout), { text: "hi" });
    const refused = await remoteCli(remote, ["fixture", "refuse"]);
    assert.equal(refused.code, 1);
    const crash = await remoteCli(remote, ["fixture", "crash"]);
    assert.equal(crash.code, 5);
    assert.equal(kindOf(crash.stderr), "internal");
    const unknown = await remoteCli(remote, ["call", "fixture.nothing"]);
    assert.equal(unknown.code, 2);
    assert.ok(seen.length >= 4 && seen.every((header) => header === SECRET));
    for (const run of [echo, refused, crash, unknown]) assert.ok(!`${run.stdout}${run.stderr}`.includes("s3cr3t"));
  });

  test("list marks a capability that the server does not list as unavailable", async (context) => {
    const url = await served(() => Response.json([{ id: "fixture.echo", available: true }, { id: "fixture.toggle", available: false, reason: "Off." }]), context);
    const run = await remoteCli(httpClient(url), ["list"]);
    assert.equal(run.code, 0);
    const listed: unknown = JSON.parse(run.stdout);
    assert.ok(Array.isArray(listed));
    const entry = (id: string): unknown => listed.find((item: unknown) => typeof item === "object" && item !== null && "id" in item && item.id === id);
    assert.partialDeepStrictEqual(entry("fixture.echo"), { available: true });
    assert.partialDeepStrictEqual(entry("fixture.toggle"), { available: false, reason: "Off." });
    assert.partialDeepStrictEqual(entry("fixture.refuse"), { available: false, reason: "The server does not serve this capability." });
  });

  test("watch writes each occurrence, ends with the call failure of an error message, and an interrupt ends it with 130", async (context) => {
    const occurrence = { eventId: "1", name: "fixture.ticks", timestamp: "2026-01-01T00:00:00.000Z", data: { n: 1 }, cursor: "1" };
    const failing = await served(
      () => new Response(`: hello\r\nid: 1\r\nevent: next\r\ndata: ${JSON.stringify(occurrence)}\r\n\r\nevent: error\ndata: {"kind":"internal","message":"The event failed."}\n\n`, { headers: { "Content-Type": "text/event-stream; charset=utf-8" } }),
      context,
    );
    const failed = await remoteCli(httpClient(failing), ["watch", "fixture.ticks", "--count", "1"]);
    assert.equal(failed.code, 5);
    assert.deepEqual(JSON.parse(failed.stdout), occurrence);
    assert.deepEqual(JSON.parse(failed.stderr), { kind: "internal", message: "The event failed." });

    const complete = await served(() => new Response(`event: next\ndata: ${JSON.stringify(occurrence)}\n\nevent: complete\ndata:\n\n`, { headers: { "Content-Type": "text/event-stream" } }), context);
    const completed = await remoteCli(httpClient(complete), ["watch", "fixture.ticks", "--count", "1"]);
    assert.equal(completed.code, 0);
    assert.equal(completed.stderr, "");

    // A stream that sends one occurrence, then nothing until the client closes it.
    let closed = false;
    const open = await served((request) => {
      request.signal.addEventListener("abort", () => (closed = true));
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`event: next\ndata: ${JSON.stringify(occurrence)}\n\n`));
        },
      });
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    }, context);
    const interrupt = new AbortController();
    const stdout: string[] = [];
    const cliOptions: CliOptions<Context> = { name: "fixture", version: "0.0.0", ...options(), remote: httpClient(open) };
    const running = runCli(fixture, cliOptions, ["watch", "fixture.ticks", "--count", "1"], {
      stdout: (text) => {
        stdout.push(text);
        interrupt.abort();
      },
      stderr: () => undefined,
      signal: interrupt.signal,
    });
    assert.equal(await running, 130);
    assert.equal(stdout.length, 1);
    for (let turn = 0; !closed && turn < 100; turn++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(closed, "the interrupt closes the request");
  });

  test("an interrupt during a call is cancelled, with exit code 130", async (context) => {
    const url = await served((request) => new Promise<Response>((resolve) => request.signal.addEventListener("abort", () => resolve(new Response(null)))), context);
    const interrupt = new AbortController();
    setTimeout(() => interrupt.abort(), 50);
    const run = await remoteCli(httpClient(url), ["fixture", "echo", "--text", "hi"], interrupt.signal);
    assert.equal(run.code, 130);
    assert.equal(kindOf(run.stderr), "cancelled");
  });

  test("httpClient refuses a URL that is not http or https, and does not write the value of a header that is not valid", () => {
    assert.throws(() => httpClient("ftp://example.com"), /not an http or https URL/);
    assert.throws(() => httpClient("not a url"), /not a URL/);
    assert.throws(() => httpClient("http://user:password@example.com"), /user name or a password/);
    assert.throws(
      () => httpClient("http://example.com", { headers: { Authorization: "s3cr3t\nvalue" } }),
      (error: unknown) => error instanceof Error && error.message.includes("Authorization") && !error.message.includes("s3cr3t"),
    );
  });
});

describe("SseParser", () => {
  test("reads lines that end with CRLF, LF or CR, also split between chunks, and skips comments and other fields", () => {
    const parser = new SseParser();
    const text = "﻿: comment\r\nid: 7\r\nevent: next\r\ndata: one\r\ndata:two\r\n\r\nevent: complete\rdata\r\rretry: 10\n\n";
    const messages = Array.from({ length: text.length }, (_, index) => text.charAt(index)).flatMap((character) => parser.push(character));
    assert.deepEqual(messages, [
      { event: "next", data: "one\ntwo" },
      { event: "complete", data: "" },
    ]);
  });
});
