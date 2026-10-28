import assert from "node:assert/strict";
import { test } from "node:test";

import { Cause, Effect, Fiber, Queue, Schema, Sink, Stdio, Stream } from "effect";

import { Mcp } from "../src/index.ts";
import { fixture, fixtureLayer } from "./fixture.ts";

/** A JSON-RPC response, as the test reads it from standard output. */
const Response = Schema.Struct({ id: Schema.Unknown, result: Schema.optional(Schema.Unknown) });

test("serveStdio answers the lines of standard input, and completes when standard input ends", async () => {
  const program = Effect.gen(function* () {
    const stdin = yield* Queue.unbounded<string, Cause.Done>();
    const stdout = yield* Queue.unbounded<string>();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const stdio = Stdio.layerTest({
      stdin: Stream.fromQueue(stdin).pipe(Stream.map((line) => encoder.encode(`${line}\n`))),
      stdout: () => Sink.forEach((chunk: string | Uint8Array) => Queue.offer(stdout, typeof chunk === "string" ? chunk : decoder.decode(chunk))),
    });
    const send = (message: object) => Queue.offer(stdin, JSON.stringify(message));
    /** The next response on standard output. Each write of the server is one line. */
    const response = Effect.map(Queue.take(stdout), (line) => Schema.decodeUnknownSync(Schema.fromJsonString(Response))(line.trim()));

    const served = yield* Mcp.serveStdio(fixture, { name: "fixture", version: "0.0.0" }).pipe(
      Effect.provide(fixtureLayer),
      Effect.provide(stdio),
      Effect.forkChild({ startImmediately: true }),
    );
    yield* send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
    const initialized = yield* response;
    yield* send({ jsonrpc: "2.0", method: "notifications/initialized" });
    yield* send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "fixture.echo", arguments: { text: "hello" } } });
    const echoed = yield* response;
    yield* Queue.end(stdin);
    yield* Fiber.join(served);
    return { initialized, echoed };
  });
  const { initialized, echoed } = await Effect.runPromise(Effect.scoped(program));
  assert.equal(initialized.id, 1);
  assert.deepEqual(echoed, { id: 2, result: { content: [{ type: "text", text: '{"text":"hello"}' }], structuredContent: { text: "hello" } } });
});
