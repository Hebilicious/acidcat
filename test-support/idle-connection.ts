import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { connect, Socket } from "node:net";

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

/**
 * Starts a server with a handler that answers when the test releases it, sends a request on a connection that the
 * client never closes, closes the server while the response is open, and then releases the response. Resolves when
 * the close is complete and the server has closed the connection. When the test ends first, the client closes the
 * connection, so that the server and the test process end.
 */
export async function closeDuringResponse(t: { readonly signal: AbortSignal }, start: (handler: () => Promise<Response>) => Promise<Closable>): Promise<void> {
  const received = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const served = await start(async () => {
    received.resolve();
    await release.promise;
    return new Response("ok");
  });
  const client = connect(Number(new URL(served.url).port), "127.0.0.1");
  const ended = new Promise<void>((resolve) => client.on("close", () => resolve()));
  client.on("error", () => {});
  t.signal.addEventListener("abort", () => client.destroy(), { once: true });
  client.resume();
  client.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
  await received.promise;
  const closed = served.close();
  release.resolve();
  await Promise.all([closed, ended]);
}
