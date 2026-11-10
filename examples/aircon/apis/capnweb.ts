/**
 * A Cap'n Web API for the air conditioner, next to the HTTP binding at `/api`.
 *
 * The API is a class with typed methods. A client calls them as if they were local, and can send many calls in one
 * request. Each method gives the result of its capability as a value: `{ ok: true, value }` or
 * `{ ok: false, error }`. A call failure rejects, as a `CallFailureError` does.
 *
 * `followStatus(listener)` follows the event `aircon.status.changed`. The client gives a function, and the server
 * calls it with each new status. The method returns a `Following` object: when the client disposes it, the
 * subscription ends. A call back to the client needs a connection that stays open, so a client follows the status
 * through WebSockets (`capnwebWebSocket`). Each connection is one session.
 */
import { RpcSession, RpcTarget, newHttpBatchRpcResponse } from "capnweb";
import type { RpcStub, RpcTransport } from "capnweb";
import type { Session } from "@acid-cat/core-ts";
import type { WebSocket, WebSocketServer } from "ws";
import type { z } from "zod";

import { fanSet, modeSet, powerSet, statusChanged, statusGet, temperatureSet } from "../core-ts/aircon.ts";
import type { Context, FanSpeed, Mode, Status } from "../core-ts/aircon.ts";
import { forbidden, foreignOrigin, httpBinding, openSession } from "./shared.ts";
import type { ApiOptions } from "./shared.ts";

/**
 * The methods that a client can call, on the session of one batch. The types of the parameters are for the client. A
 * client can send any value, so `session.call` checks the arguments with the input schema of the capability.
 */
/** A function of the client. The server calls it with each new status of the unit. */
export type StatusListener = (status: z.infer<typeof Status>) => void;

/** A subscription that the client holds. When the client disposes its stub, the subscription ends. */
export class Following extends RpcTarget {
  readonly #stop: () => void;

  constructor(stop: () => void) {
    super();
    this.#stop = stop;
  }

  [Symbol.dispose]() {
    this.#stop();
  }
}

export class AirconApi extends RpcTarget {
  readonly #session: Session<Context>;

  constructor(session: Session<Context>) {
    super();
    this.#session = session;
  }

  status() {
    return this.#session.call(statusGet, {});
  }

  setPower(on: boolean) {
    return this.#session.call(powerSet, { on });
  }

  setMode(mode: z.infer<typeof Mode>) {
    return this.#session.call(modeSet, { mode });
  }

  setFan(speed: z.infer<typeof FanSpeed>) {
    return this.#session.call(fanSet, { speed });
  }

  setTemperature(celsius: number) {
    return this.#session.call(temperatureSet, { celsius });
  }

  /**
   * Call `listener` with each new status, until the client disposes the result, the listener fails, or the session
   * closes. The promise resolves when the subscription has started. It rejects with a `CallFailureError` when the
   * subscription cannot start.
   */
  async followStatus(listener: RpcStub<StatusListener>): Promise<Following> {
    const stop = new AbortController();
    const occurrences = await this.#session.eventHandle(statusChanged).subscribe({}, { signal: stop.signal });
    // Cap'n Web disposes the stubs of the parameters when the call returns. The duplicate stays usable after that.
    const client = listener.dup();
    client.onRpcBroken(() => stop.abort());
    void deliver(occurrences, client);
    return new Following(() => stop.abort());
  }
}

/**
 * Give each occurrence to the client, one at a time: the next one waits until the client has received the one before
 * it. When the client cannot receive it, the loop ends, and so cancels the subscription.
 */
async function deliver(occurrences: AsyncIterable<{ readonly data: z.infer<typeof Status> }>, client: RpcStub<StatusListener>) {
  try {
    for await (const occurrence of occurrences) await client(occurrence.data);
  } catch {
    // The client went away, its listener failed, or the subscription failed. In each case, the subscription ends.
  } finally {
    client[Symbol.dispose]();
  }
}

/** A web request handler: Cap'n Web batches at `/rpc`, and the HTTP binding at `/api`. Each batch has its own session. */
export function capnwebApi(options: ApiOptions): (request: Request) => Promise<Response> {
  const http = httpBinding(options, "/api");
  return async (request) => {
    if (foreignOrigin(request, options)) return forbidden();
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/")) return http(request);
    if (path !== "/rpc") return new Response(null, { status: 404 });
    await using session = openSession(options);
    return await newHttpBatchRpcResponse(request, new AirconApi(session));
  };
}

/**
 * A Cap'n Web transport on a WebSocket of `ws`. Each message is one string. When the socket closes, `receive` rejects,
 * and Cap'n Web ends the RPC session.
 */
function webSocketTransport(socket: WebSocket): RpcTransport {
  const received: string[] = [];
  let waiting: { resolve: (message: string) => void; reject: (error: Error) => void } | undefined;
  let closed: Error | undefined;
  const fail = (error: Error) => {
    closed ??= error;
    waiting?.reject(closed);
    waiting = undefined;
  };
  socket.on("message", (data, isBinary) => {
    if (isBinary) return fail(new TypeError("A Cap'n Web message is text."));
    const bytes = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data;
    const message = bytes.toString("utf8");
    if (waiting === undefined) received.push(message);
    else waiting.resolve(message);
    waiting = undefined;
  });
  socket.on("close", (code, reason) => fail(new Error(`The WebSocket closed: ${code} ${reason.toString()}`)));
  socket.on("error", fail);
  return {
    send: (message) => socket.send(message),
    receive: () => {
      const message = received.shift();
      if (message !== undefined) return Promise.resolve(message);
      if (closed !== undefined) return Promise.reject(closed);
      return new Promise((resolve, reject) => (waiting = { resolve, reject }));
    },
    abort: () => socket.close(1011),
  };
}

/**
 * Serve the API through WebSockets on a `ws` server. Each connection is one session: it opens when the client connects,
 * and closes when the connection closes, which ends each subscription of the connection. A connection from an origin
 * that the API does not allow is closed with the code 4403.
 */
export function capnwebWebSocket(options: ApiOptions, server: WebSocketServer): void {
  server.on("connection", (socket, request) => {
    const origin = request.headers.origin;
    if (origin !== undefined && !(options.allowedOrigins ?? []).includes(origin)) {
      socket.close(4403, "Forbidden");
      return;
    }
    const session = openSession(options);
    socket.once("close", () => void session.dispose());
    // The RPC session reads the messages of the transport until the socket closes.
    new RpcSession(webSocketTransport(socket), new AirconApi(session));
  });
}
