import { subscribe, unsubscribe } from "node:diagnostics_channel";
import assert from "node:assert/strict";
import { connect, Socket } from "node:net";
import type { TestContext } from "node:test";

const RESPONSE_FINISH = "http.server.response.finish";

function socketOf(message: unknown): Socket | undefined {
  return typeof message === "object" && message !== null && "socket" in message && message.socket instanceof Socket ? message.socket : undefined;
}

/**
 * Sends one request with `fetch`, and tells what the server does with the idle connection after the response: the
 * idle timeout that it sets on the connection (`undefined` for none), and its `Keep-Alive` header.
 */
export async function idleConnection(url: string): Promise<{ readonly idleTimeoutMs: number | undefined; readonly keepAlive: string | null }> {
  const port = Number(new URL(url).port);
  const armed = new Promise<number | undefined>((resolve) => {
    const finished = (message: unknown) => {
      const socket = socketOf(message);
      if (socket?.localPort !== port) return;
      unsubscribe(RESPONSE_FINISH, finished);
      // Node.js publishes the message, then sets the idle timeout of the connection, in the same task.
      process.nextTick(() => resolve(socket.timeout));
    };
    subscribe(RESPONSE_FINISH, finished);
  });
  const response = await fetch(url);
  await response.text();
  return { idleTimeoutMs: await armed, keepAlive: response.headers.get("keep-alive") };
}

export interface Closable {
  readonly url: string;
  close(): Promise<void>;
}

type Start = (handler: () => Promise<Response>) => Promise<Closable>;

/** A connection to the server that records what it reads, and whether the server ends it without an error. */
function rawConnection(t: { readonly signal: AbortSignal }, url: string) {
  const socket = connect(Number(new URL(url).port), "127.0.0.1");
  let text = "";
  let read = Promise.withResolvers<void>();
  let error: Error | undefined;
  let ended = false;
  socket.setEncoding("latin1").on("data", (chunk: string) => {
    text += chunk;
    read.resolve();
    read = Promise.withResolvers<void>();
  });
  socket.on("error", (cause) => (error = cause));
  const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
  socket.on("end", () => (ended = true));
  // When the test ends first, the client closes the connection, so that the server and the test process end.
  t.signal.addEventListener("abort", () => socket.destroy(), { once: true });
  const answers = () => text.split("HTTP/1.1 204").length - 1;
  return {
    write: (data: string) => socket.write(data),
    answers,
    ended: () => ended,
    async untilAnswers(count: number) {
      while (answers() < count) await read.promise;
    },
    async closed() {
      await closed;
      return { answers: answers(), error: error?.message };
    },
  };
}

/** A server whose handler answers `204` when the test releases it, and resolves `received` at each request. */
async function heldServer(start: Start) {
  let received = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const served = await start(async () => {
    received.resolve();
    received = Promise.withResolvers<void>();
    await release.promise;
    return new Response(null, { status: 204 });
  });
  return { served, received: () => received.promise, release: () => release.resolve() };
}

const GET = "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";

/**
 * Tests that `close` of a server resolves when the server has ended each connection, and that the server cuts no
 * request that it accepted: with an idle connection, during a response, during a request whose body is still arriving
 * when its response is complete, and with a second request sent before the first answer.
 */
export async function checkClose(t: TestContext, start: Start): Promise<void> {
  await t.test("an idle connection ends", async (t) => {
    const { served, release } = await heldServer(start);
    release();
    const client = rawConnection(t, served.url);
    client.write(GET);
    await client.untilAnswers(1);
    await served.close();
    assert.deepEqual(await client.closed(), { answers: 1, error: undefined });
  });

  await t.test("a connection ends after the response that runs when the server closes", async (t) => {
    const { served, received, release } = await heldServer(start);
    const client = rawConnection(t, served.url);
    const arrived = received();
    client.write(GET);
    await arrived;
    const closed = served.close();
    release();
    await closed;
    assert.deepEqual(await client.closed(), { answers: 1, error: undefined });
  });

  await t.test("a connection ends after the end of a request body that still arrives when the response is complete", async (t) => {
    const { served, received, release } = await heldServer(start);
    const client = rawConnection(t, served.url);
    const arrived = received();
    client.write("POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\n\r\na");
    await arrived;
    const closed = served.close();
    release();
    await client.untilAnswers(1);
    assert.equal(client.ended(), false, "the server waits for the rest of the request");
    client.write("b");
    await closed;
    assert.deepEqual(await client.closed(), { answers: 1, error: undefined });
  });

  await t.test("a connection ends after the answer to a second request that the client sent before the first answer", async (t) => {
    const { served, received, release } = await heldServer(start);
    const client = rawConnection(t, served.url);
    const arrived = received();
    client.write(GET + GET);
    await arrived;
    const closed = served.close();
    release();
    await closed;
    assert.deepEqual(await client.closed(), { answers: 2, error: undefined });
  });
}
