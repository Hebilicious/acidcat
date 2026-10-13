/**
 * A Cap'n Web API for the air conditioner, next to the HTTP binding at `/api`.
 *
 * The API is a class with typed methods. A client calls them as if they were local, and can send many calls in one
 * request. Each method gives the result of its capability as a value: `{ ok: true, value }` or
 * `{ ok: false, error }`. A call failure rejects, as a `CallFailureError` does.
 */
import { RpcTarget, newHttpBatchRpcResponse } from "capnweb";
import type { Result, Session } from "@acid-cat/core-ts";
import type { z } from "zod";

import { apiSession, forbidden, foreignOrigin, httpBinding, result } from "./aircon.ts";
import type { ApiOptions, FanSpeed, Mode, StatusValue } from "./aircon.ts";

type Offline = { readonly _tag: "Offline"; readonly since?: string };
type PoweredOff = { readonly _tag: "PoweredOff" };

/** The methods that a client can call. */
export class AirconApi extends RpcTarget {
  readonly #session: Session;

  constructor(session: Session) {
    super();
    this.#session = session;
  }

  status() {
    return result(this.#session, "aircon.status.get", {}) as Promise<Result<StatusValue, Offline>>;
  }

  setPower(on: boolean) {
    return result(this.#session, "aircon.power.set", { on }) as Promise<Result<null, Offline>>;
  }

  setMode(mode: z.infer<typeof Mode>) {
    return result(this.#session, "aircon.mode.set", { mode }) as Promise<Result<null, Offline | PoweredOff>>;
  }

  setFan(speed: z.infer<typeof FanSpeed>) {
    return result(this.#session, "aircon.fan.set", { speed }) as Promise<Result<null, Offline>>;
  }

  setTemperature(celsius: number) {
    return result(this.#session, "aircon.temperature.set", { celsius }) as Promise<Result<null, Offline>>;
  }
}

/** A web request handler: Cap'n Web batches at `/rpc`, and the HTTP binding at `/api`. */
export function capnwebApi(options: ApiOptions): (request: Request) => Promise<Response> {
  const api = new AirconApi(apiSession(options));
  const http = httpBinding(options, "/api");
  return async (request) => {
    if (foreignOrigin(request, options)) return forbidden();
    const path = new URL(request.url).pathname;
    if (path === "/rpc") return newHttpBatchRpcResponse(request, api);
    return path.startsWith("/api/") ? http(request) : new Response(null, { status: 404 });
  };
}
