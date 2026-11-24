import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { httpClient, httpHandler, runCli } from "../src/index.ts";
import type { CliOptions, HttpClient } from "../src/index.ts";
import { SseParser } from "../src/http-client.ts";
import { serve } from "../src/node.ts";
import type { WebHandler } from "../src/node.ts";
import { fixture, options } from "./fixture.ts";
import type { Context } from "./fixture.ts";
import { until } from "./until.ts";

const SECRET = "Bearer s3cr3t-t0k3n";

async function remoteCli(remote: HttpClient, args: readonly string[], signal?: AbortSignal) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const cliOptions: CliOptions<Context> = { name: "fixture", version: "0.0.0", ...options(), remote };
  const code = await runCli(fixture, cliOptions, args, { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text), signal });
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

const kindOf = (stderr: string): unknown => {
  const parsed: unknown = JSON.parse(stderr);
  return typeof parsed === "object" && parsed !== null && "kind" in parsed ? parsed.kind : undefined;
};

async function served(handler: WebHandler, context: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const server = await serve(handler, { port: 0 });
  context.after(() => server.close());
  return server.url;
}

describe("the command line that calls a server", () => {
  test("a server that does not answer is unavailable, with exit code 4, and the header is not written", async () => {
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

  test("an answer that the HTTP surface does not give, or a stream with an occurrence that is not valid or with no complete, is internal, with exit code 5", async (context) => {
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
    for (const stream of ['event: next\ndata: {"not":"an occurrence"}\n\n', ": only a comment\n\n"]) {
      const url = await served(() => new Response(stream, { headers: { "Content-Type": "text/event-stream" } }), context);
      const run = await remoteCli(httpClient(url), ["watch", "fixture.ticks", "--count", "1"]);
      assert.equal(run.code, 5);
      assert.equal(kindOf(run.stderr), "internal");
    }
  });

  test("the client sends the headers, and never writes their values", async (context) => {
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
    const crash = await remoteCli(remote, ["fixture", "crash"]);
    assert.equal(crash.code, 5);
    assert.deepEqual(seen, [SECRET, SECRET]);
    for (const run of [echo, crash]) assert.ok(!`${run.stdout}${run.stderr}`.includes("s3cr3t"));
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

  test("an interrupt during list or a call is cancelled, with exit code 130, and closes the request", async (context) => {
    for (const args of [["list"], ["fixture", "echo", "--text", "hi"]]) {
      const interrupt = new AbortController();
      let closed = false;
      const url = await served(
        (request) =>
          new Promise<Response>(() => {
            request.signal.addEventListener("abort", () => (closed = true));
            interrupt.abort();
          }),
        context,
      );
      const run = await remoteCli(httpClient(url), args, interrupt.signal);
      assert.equal(run.code, 130, args.join(" "));
      assert.equal(kindOf(run.stderr), "cancelled");
      assert.equal(run.stdout, "");
      await until(context, () => closed);
    }
  });

  test("watch writes each occurrence, then ends with the call failure of an error message", async (context) => {
    const occurrence = { eventId: "1", name: "fixture.ticks", timestamp: "2026-01-01T00:00:00.000Z", data: { n: 1 }, cursor: "1" };
    const url = await served(
      () => new Response(`event: next\ndata: ${JSON.stringify(occurrence)}\n\nevent: error\ndata: {"kind":"internal","message":"The event failed."}\n\n`, { headers: { "Content-Type": "text/event-stream" } }),
      context,
    );
    const run = await remoteCli(httpClient(url), ["watch", "fixture.ticks", "--count", "1"]);
    assert.equal(run.code, 5);
    assert.deepEqual(JSON.parse(run.stdout), occurrence);
    assert.deepEqual(JSON.parse(run.stderr), { kind: "internal", message: "The event failed." });
  });

  test("an interrupt before the server answers a subscription ends watch with 130, and writes nothing", async (context) => {
    const interrupt = new AbortController();
    let closed = false;
    const url = await served(
      (request) =>
        new Promise<Response>(() => {
          request.signal.addEventListener("abort", () => (closed = true));
          interrupt.abort();
        }),
      context,
    );
    const run = await remoteCli(httpClient(url), ["watch", "fixture.ticks", "--count", "1"], interrupt.signal);
    assert.equal(run.code, 130);
    assert.equal(run.stderr, "");
    assert.equal(run.stdout, "");
    await until(context, () => closed);
  });

  test("a cursor that cannot be a header value is invalid-input, with exit code 3, and sends no request", async (context) => {
    let requests = 0;
    const url = await served(() => {
      requests++;
      return new Response(null);
    }, context);
    for (const cursor of ["a→b", "a\nb", "a\rb"]) {
      const run = await remoteCli(httpClient(url), ["watch", "fixture.ticks", "--count", "1", "--cursor", cursor]);
      assert.equal(run.code, 3, JSON.stringify(cursor));
      assert.equal(kindOf(run.stderr), "invalid-input");
      assert.equal(run.stdout, "");
    }
    assert.equal(requests, 0);
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

  test("gives a message with no data line only when its event is complete", () => {
    const parser = new SseParser();
    assert.deepEqual(parser.push("event: next\n\nevent: complete\n\n\n"), [{ event: "complete", data: "" }]);
  });
});
