/** Conformance checks for the HTTP binding (spec/bindings/http.md). */
import { randomUUID } from "node:crypto";

import { isArrayOf, isObject, isStringArray, memberOf, parseJson, readJson } from "../json.ts";
import type { JsonObject } from "../json.ts";
import { Checks, eventIdsOf, expect, expectEqual, expectOccurrence, FORBIDDEN_ORIGIN, idsOf, sorted, until } from "./check.ts";
import { sseReader } from "./sse.ts";

const RULE = "spec/bindings/http.md";

/** An entry of the list that `GET /capabilities` gives. */
type Entry = JsonObject & { readonly id: string };

const isEntry = (value: unknown): value is Entry => isObject(value) && typeof value.id === "string";

/** The list that `GET /capabilities` gives. The check fails when it is not a list of entries. */
async function entriesOf(response: Response): Promise<readonly Entry[]> {
  const list = await readJson(response);
  if (!isArrayOf(list, isEntry)) throw new Error(`GET /capabilities must give a list of objects with an id, got ${JSON.stringify(list)}`);
  return list;
}

export async function checkHttp(base: string, options: { readonly maximumBytes: number; readonly deadline: number }): Promise<Checks> {
  const checks = new Checks("http", options.deadline);
  const post = (signal: AbortSignal, id: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/capabilities/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : body instanceof Uint8Array ? new Blob([new Uint8Array(body)]) : JSON.stringify(body),
      signal,
    });
  const kindOf = async (response: Response) => memberOf(await readJson(response), "kind");

  await checks.run("GET /capabilities lists the view with availability", `${RULE}#requests`, async (signal) => {
    const list = await entriesOf(await fetch(`${base}/capabilities`, { signal }));
    expectEqual(sorted(list.map((entry) => entry.id)), idsOf("api"), "ids");
    expect(list.every((entry) => typeof entry.available === "boolean"), "each entry must have available");
  });
  await checks.run("a value has the status 200", `${RULE}#requests`, async (signal) => {
    const response = await post(signal, "fixture.echo", { text: "hello" });
    expectEqual(response.status, 200, "status");
    expectEqual(await readJson(response), { ok: true, value: { text: "hello" } }, "body");
  });
  await checks.run("a failure has the status 200 and ok: false", `${RULE}#requests`, async (signal) => {
    const response = await post(signal, "fixture.refuse", {});
    const body = await readJson(response);
    expectEqual(response.status, 200, "status");
    expect(memberOf(body, "ok") === false && memberOf(memberOf(body, "error"), "_tag") === "Refused", `got ${JSON.stringify(body)}`);
  });
  for (const [name, id, input, status, kind] of [
    ["invalid input has the status 422", "fixture.echo", { text: 1 }, 422, "invalid-input"],
    ["a capability outside the view has the status 404", "fixture.hidden", {}, 404, "unknown-capability"],
    ["a defect has the status 500", "fixture.crash", {}, 500, "internal"],
  ] as const) {
    await checks.run(name, `${RULE}#requests`, async (signal) => {
      const response = await post(signal, id, input);
      expectEqual(response.status, status, "status");
      expectEqual(await kindOf(response), kind, "kind");
    });
  }
  await checks.run("an unavailable capability has the status 503", `${RULE}#requests`, async (signal) => {
    await post(signal, "fixture.switch.set", { on: false });
    try {
      const list = await entriesOf(await fetch(`${base}/capabilities`, { signal }));
      const toggle = list.find((entry) => entry.id === "fixture.toggle");
      expect(toggle?.available === false && typeof toggle.reason === "string", "fixture.toggle must be unavailable, with a reason");
      const response = await post(signal, "fixture.toggle", {});
      expectEqual(response.status, 503, "status");
      expectEqual(await kindOf(response), "unavailable", "kind");
    } finally {
      await post(AbortSignal.timeout(options.deadline), "fixture.switch.set", { on: true });
    }
  });

  const status = async (response: Response, expected: number) => expectEqual(response.status, expected, "status");
  await checks.run("a method that is not accepted is rejected with 405", `${RULE}#requests`, async (signal) => {
    await status(await fetch(`${base}/capabilities`, { method: "PUT", signal }), 405);
  });
  await checks.run("an origin that is not allowed is rejected with 403", `${RULE}#requests`, async (signal) => {
    await status(await post(signal, "fixture.echo", { text: "x" }, { Origin: FORBIDDEN_ORIGIN }), 403);
  });
  await checks.run("a media type other than JSON is rejected with 415", `${RULE}#requests`, async (signal) => {
    await status(await post(signal, "fixture.echo", { text: "x" }, { "Content-Type": "text/plain" }), 415);
  });
  await checks.run("a body over the limit is rejected with 413", `${RULE}#requests`, async (signal) => {
    await status(await post(signal, "fixture.echo", " ".repeat(options.maximumBytes + 1)), 413);
  });
  await checks.run("a body that is not UTF-8 is rejected with 400", `${RULE}#requests`, async (signal) => {
    await status(await post(signal, "fixture.echo", new Uint8Array([0x7b, 0xff, 0x7d])), 400);
  });

  await checkEvents(checks, base);
  return checks;
}

const EVENTS = `${RULE}#events`;

/** A subscription through the HTTP binding: the response, and its messages. Closing it cancels the subscription. */
interface Stream {
  readonly response: Response;
  readonly reader: ReturnType<typeof sseReader>;
  close(): void;
}

/** The checks of the events (spec/bindings/http.md#events). */
async function checkEvents(checks: Checks, base: string): Promise<void> {
  const subscribe = (signal: AbortSignal, id: string, input: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/events/${id}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(input), signal });
  /** Subscribe, and check that the stream starts. `signal` and `close` both close the stream. */
  const open = async (signal: AbortSignal, id: string, input: unknown, headers: Record<string, string> = {}): Promise<Stream> => {
    const controller = new AbortController();
    const response = await subscribe(AbortSignal.any([signal, controller.signal]), id, input, headers);
    if (response.status !== 200) {
      controller.abort();
      throw new Error(`POST /events/${id} must start a stream with the status 200, got ${response.status}`);
    }
    expect(response.headers.get("Content-Type")?.startsWith("text/event-stream") === true, `the media type must be text/event-stream, got ${response.headers.get("Content-Type")}`);
    expectEqual(response.headers.get("Cache-Control"), "no-store", "Cache-Control");
    return { response, reader: sseReader(response), close: () => controller.abort() };
  };
  /** The next message of a stream, which must be an occurrence of the event with the cursor as its SSE id. */
  const nextOccurrence = async (stream: Stream, id: string) => {
    const message = await stream.reader.next();
    expect(message?.event === "next", `expected event: next, got ${JSON.stringify(message)}`);
    const occurrence = expectOccurrence(parseJson(message.data), id);
    expectEqual(message.id, occurrence.cursor, "the SSE id of the message, which is the cursor of the occurrence");
    return occurrence;
  };
  const expectComplete = async (stream: Stream) => {
    const message = await stream.reader.next();
    expect(message?.event === "complete", `expected event: complete, got ${JSON.stringify(message)}`);
    expectEqual(message.data, "", "the data of event: complete");
    expectEqual(await stream.reader.next(), undefined, "the stream after event: complete");
  };
  const watching = async (signal: AbortSignal): Promise<readonly string[]> => {
    const response = await fetch(`${base}/capabilities/fixture.watching`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal });
    const keys = memberOf(memberOf(await readJson(response), "value"), "keys");
    expect(isStringArray(keys), `fixture.watching must give a list of keys, got ${JSON.stringify(keys)}`);
    return keys;
  };
  const count = (keys: readonly string[], key: string) => keys.filter((each) => each === key).length;
  const signalKey = async (signal: AbortSignal, key: string, value: string) => {
    const response = await fetch(`${base}/capabilities/fixture.signal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, value }), signal });
    const delivered = memberOf(memberOf(await readJson(response), "value"), "delivered");
    expect(typeof delivered === "number", `fixture.signal must give the number of subscriptions, got ${JSON.stringify(delivered)}`);
    return delivered;
  };

  await checks.run("GET /events lists the events of the view", `${RULE}#requests`, async (signal) => {
    const list = await readJson(await fetch(`${base}/events`, { signal }));
    if (!isArrayOf(list, isEntry)) throw new Error(`GET /events must give a list of objects with an id, got ${JSON.stringify(list)}`);
    expectEqual(sorted(list.map((entry) => entry.id)), eventIdsOf("api"), "ids");
  });
  for (const [name, id, input, status, kind] of [
    ["a subscription to an event outside the view has the status 404", "fixture.secret", {}, 404, "unknown-capability"],
    ["a subscription to the id of a capability has the status 404", "fixture.echo", { text: "x" }, 404, "unknown-capability"],
    ["a subscription with invalid input has the status 422", "fixture.ticks", { count: 101 }, 422, "invalid-input"],
  ] as const) {
    await checks.run(name, EVENTS, async (signal) => {
      const response = await subscribe(signal, id, input);
      expectEqual(response.status, status, "status");
      const body = await readJson(response);
      expectEqual(memberOf(body, "kind"), kind, "kind");
      expect(typeof memberOf(body, "message") === "string", `the call failure must have a message, got ${JSON.stringify(body)}`);
    });
  }
  await checks.run("a subscription gives each occurrence as event: next, in order, then event: complete", EVENTS, async (signal) => {
    const stream = await open(signal, "fixture.ticks", { count: 3 });
    try {
      for (const n of [1, 2, 3]) {
        const occurrence = await nextOccurrence(stream, "fixture.ticks");
        expectEqual(occurrence.data, { n }, "data");
        expectEqual([occurrence.eventId, occurrence.cursor], [String(n), String(n)], "the eventId and the cursor");
      }
      await expectComplete(stream);
    } finally {
      stream.close();
    }
  });
  await checks.run("an occurrence after a gap has truncated: true, and the other occurrences have no truncated", EVENTS, async (signal) => {
    const stream = await open(signal, "fixture.ticks", { count: 3, gap: 2 });
    try {
      for (const n of [1, 2, 3]) {
        const occurrence = await nextOccurrence(stream, "fixture.ticks");
        expectEqual([occurrence.data, occurrence.truncated], [{ n }, n === 2 ? true : undefined], "the data and truncated");
      }
      await expectComplete(stream);
    } finally {
      stream.close();
    }
  });
  await checks.run("Last-Event-ID gives the cursor, and the subscription starts after it", EVENTS, async (signal) => {
    const stream = await open(signal, "fixture.ticks", { count: 3 }, { "Last-Event-ID": "1" });
    try {
      for (const n of [2, 3]) expectEqual((await nextOccurrence(stream, "fixture.ticks")).data, { n }, "data");
      await expectComplete(stream);
    } finally {
      stream.close();
    }
  });
  await checks.run("a defect after an occurrence ends the stream with event: error and internal", EVENTS, async (signal) => {
    const stream = await open(signal, "fixture.broken", {});
    try {
      expectEqual((await nextOccurrence(stream, "fixture.broken")).data, { n: 1 }, "data");
      const message = await stream.reader.next();
      expect(message?.event === "error", `expected event: error, got ${JSON.stringify(message)}`);
      const failure = parseJson(message.data);
      expect(memberOf(failure, "kind") === "internal" && typeof memberOf(failure, "message") === "string", `expected { kind: "internal", message }, got ${message.data}`);
      expect(!/\n\s+at /.test(String(memberOf(failure, "message"))), "the message must not contain a stack trace");
      expectEqual(await stream.reader.next(), undefined, "the stream after event: error");
    } finally {
      stream.close();
    }
  });
  await checks.run("a subscription gets the things that happen, and closing the stream cancels it", EVENTS, async (signal) => {
    const key = randomUUID();
    const pending = open(signal, "fixture.watch", { key });
    pending.catch(() => undefined);
    let stream: Stream | undefined;
    try {
      await until("fixture.watching gives the key", () => watching(signal), (keys) => keys.includes(key), signal);
      stream = await pending;
      expectEqual(await signalKey(signal, key, "first"), 1, "the subscriptions that fixture.signal reached");
      expectEqual((await nextOccurrence(stream, "fixture.watch")).data, { key, value: "first" }, "data");
      stream.close();
      await until("the key leaves fixture.watching", () => watching(signal), (keys) => !keys.includes(key), signal);
    } finally {
      stream?.close();
      void pending.then((opened) => opened.close(), () => undefined);
    }
  });
  await checks.run("cancelling one subscription leaves the other subscriptions running", EVENTS, async (signal) => {
    const key = randomUUID();
    const first = open(signal, "fixture.watch", { key });
    const second = open(signal, "fixture.watch", { key });
    first.catch(() => undefined);
    second.catch(() => undefined);
    try {
      await until("fixture.watching gives the key of both subscriptions", () => watching(signal), (keys) => count(keys, key) === 2, signal);
      const [cancelled, kept] = [await first, await second];
      cancelled.close();
      await until("the cancelled subscription leaves fixture.watching", () => watching(signal), (keys) => count(keys, key) === 1, signal);
      expectEqual(await signalKey(signal, key, "after"), 1, "the subscriptions that fixture.signal reached");
      expectEqual((await nextOccurrence(kept, "fixture.watch")).data, { key, value: "after" }, "data");
    } finally {
      for (const stream of [first, second]) void stream.then((opened) => opened.close(), () => undefined);
    }
  });
}
