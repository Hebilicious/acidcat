/**
 * A Cap'n Web API for the air conditioner, next to the HTTP binding at `/api`.
 *
 * The API is a class with typed methods. A client calls them as if they were local, and can send many calls in one
 * request. Each method gives the result of its capability as a value: `{ ok: true, value }` or
 * `{ ok: false, error }`. A call failure rejects, as a `CallFailureError` does.
 */
import { RpcTarget, newHttpBatchRpcResponse } from "capnweb";
import { getHandle } from "@acid-cat/core-ts";
import type { Session } from "@acid-cat/core-ts";
import type { z } from "zod";

import { FanInput, fanSet, ModeInput, modeSet, PowerInput, powerSet, statusGet, TemperatureInput, temperatureSet } from "../core-ts/aircon.ts";
import type { Context, FanSpeed, Mode } from "../core-ts/aircon.ts";
import { decode, forbidden, foreignOrigin, httpBinding, withSession } from "./shared.ts";
import type { ApiOptions } from "./shared.ts";

/**
 * The methods that a client can call, on the session of one request. The types of the parameters are for the client.
 * A client can send any value, so each method checks its arguments with the input schema of its capability, then
 * makes a typed call.
 */
export class AirconApi extends RpcTarget {
  readonly #session: Session<Context>;

  constructor(session: Session<Context>) {
    super();
    this.#session = session;
  }

  status() {
    return getHandle(this.#session.handles, statusGet).execute({});
  }

  setPower(on: boolean) {
    return getHandle(this.#session.handles, powerSet).execute(decode(PowerInput, { on }));
  }

  setMode(mode: z.infer<typeof Mode>) {
    return getHandle(this.#session.handles, modeSet).execute(decode(ModeInput, { mode }));
  }

  setFan(speed: z.infer<typeof FanSpeed>) {
    return getHandle(this.#session.handles, fanSet).execute(decode(FanInput, { speed }));
  }

  setTemperature(celsius: number) {
    return getHandle(this.#session.handles, temperatureSet).execute(decode(TemperatureInput, { celsius }));
  }
}

/** A web request handler: Cap'n Web batches at `/rpc`, and the HTTP binding at `/api`. Each batch has its own session. */
export function capnwebApi(options: ApiOptions): (request: Request) => Promise<Response> {
  const http = httpBinding(options, "/api");
  return async (request) => {
    if (foreignOrigin(request, options)) return forbidden();
    const path = new URL(request.url).pathname;
    if (path === "/rpc") return withSession(options, (session) => newHttpBatchRpcResponse(request, new AirconApi(session)));
    return path.startsWith("/api/") ? http(request) : new Response(null, { status: 404 });
  };
}
