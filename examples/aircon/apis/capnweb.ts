import { RpcSession, RpcTarget, newHttpBatchRpcResponse } from "capnweb";
import type { RpcStub, RpcTransport } from "capnweb";
import type { Session } from "@acid-cat/core-ts";
import type { WebSocket, WebSocketServer } from "ws";
import type { z } from "zod";

import { fanSet, modeSet, powerSet, statusChanged, statusGet, temperatureSet } from "../core-ts/aircon.ts";
import type { Context, FanSpeed, Mode, Status } from "../core-ts/aircon.ts";
import { forbidden, foreignOrigin, httpSurface, openSession } from "./shared.ts";
import type { ApiOptions } from "./shared.ts";

export type StatusListener = (status: z.infer<typeof Status>) => void;

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
   * A call back to the client needs a connection that stays open, so a client follows the status through WebSockets
   * (`capnwebWebSocket`).
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

async function deliver(occurrences: AsyncIterable<{ readonly data: z.infer<typeof Status> }>, client: RpcStub<StatusListener>) {
  try {
    for await (const occurrence of occurrences) await client(occurrence.data);
  } catch {
  } finally {
    client[Symbol.dispose]();
  }
}

export function capnwebApi(options: ApiOptions): (request: Request) => Promise<Response> {
  const http = httpSurface(options, "/api");
  return async (request) => {
    if (foreignOrigin(request, options)) return forbidden();
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/")) return http(request);
    if (path !== "/rpc") return new Response(null, { status: 404 });
    await using session = openSession(options);
    return await newHttpBatchRpcResponse(request, new AirconApi(session));
  };
}

/** When the socket closes, `receive` rejects, and Cap'n Web ends the RPC session. */
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

export function capnwebWebSocket(options: ApiOptions, server: WebSocketServer): void {
  server.on("connection", (socket, request) => {
    const origin = request.headers.origin;
    if (origin !== undefined && !(options.allowedOrigins ?? []).includes(origin)) {
      socket.close(4403, "Forbidden");
      return;
    }
    const session = openSession(options);
    socket.once("close", () => void session.dispose());
    new RpcSession(webSocketTransport(socket), new AirconApi(session));
  });
}
