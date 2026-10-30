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

test("serveStdio tells each change of the tools, also when the availability changes back before the server reads the change", async () => {
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
    const Message = Schema.Struct({ id: Schema.optional(Schema.Unknown), method: Schema.optional(Schema.String) });
    const message = Effect.map(Queue.take(stdout), (line) => Schema.decodeUnknownSync(Schema.fromJsonString(Message))(line.trim()));

    const served = yield* Mcp.serveStdio(fixture, { name: "fixture", version: "0.0.0" }).pipe(
      Effect.provide(fixtureLayer),
      Effect.provide(stdio),
      Effect.forkChild({ startImmediately: true }),
    );
    yield* send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
    yield* message;
    yield* send({ jsonrpc: "2.0", method: "notifications/initialized" });
    /** Read messages until `answers` answers and `changes` notifications of the tools have come. */
    const until = Effect.fnUntraced(function* (answers: number, changes: number) {
      let answered = 0;
      let changed = 0;
      while (answered < answers || changed < changes) {
        const next = yield* message;
        if (next.method === "notifications/tools/list_changed") changed += 1;
        else answered += 1;
      }
    });
    const set = (id: number, on: boolean) =>
      send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "fixture.switch.set", arguments: { on } } });
    // The switch goes off, and the client gets the change.
    yield* set(2, false);
    yield* until(1, 1);
    // The switch goes on and off again in one burst, so it ends as the client last heard. The tools changed two times,
    // and the client must hear of it.
    yield* set(3, true);
    yield* set(4, false);
    yield* until(2, 1);
    yield* Queue.end(stdin);
    yield* Fiber.join(served);
  });
  // Without the notification of the burst, the program waits until its time ends, and fails.
  await Effect.runPromise(Effect.scoped(program).pipe(Effect.timeout("5 seconds")));
});
