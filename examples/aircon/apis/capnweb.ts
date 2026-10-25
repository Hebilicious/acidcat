/**
 * A Cap'n Web API for the air conditioner, next to the HTTP binding at `/api`.
 *
 * The API is a class with typed methods. A client calls them as if they were local, and can send many calls in one
 * request. Each method gives the result of its capability as a value: `{ ok: true, value }` or
 * `{ ok: false, error }`. A call failure rejects, as a `CallFailureError` does.
 */
import { RpcTarget, newHttpBatchRpcResponse } from "capnweb";
import type { Session } from "@acid-cat/core-ts";
import type { z } from "zod";

import { fanSet, modeSet, powerSet, statusGet, temperatureSet } from "../core-ts/aircon.ts";
import type { Context, FanSpeed, Mode } from "../core-ts/aircon.ts";
import { forbidden, foreignOrigin, httpBinding, openSession } from "./shared.ts";
import type { ApiOptions } from "./shared.ts";

/**
 * The methods that a client can call, on the session of one batch. The types of the parameters are for the client. A
 * client can send any value, so `session.call` checks the arguments with the input schema of the capability.
 */
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
