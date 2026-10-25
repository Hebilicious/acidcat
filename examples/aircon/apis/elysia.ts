/**
 * An Elysia server for the air conditioner. It mounts the HTTP binding at `/api`, and adds its own routes:
 * `GET /status`, and `PATCH /status`, which changes more than one setting in one request.
 *
 * Each request has its own session. `PATCH /status` checks the shape of its body with Zod, and `session.call` checks
 * each setting with the input schema of its capability. The application chooses the status codes: a failure gives
 * `409` with the failure in the body, and a call failure gives the status code of its kind.
 */
import { CallFailureError, ok } from "@acid-cat/core-ts";
import type { Result, Session } from "@acid-cat/core-ts";
import { HTTP_STATUS } from "@acid-cat/spec-ts";
import { Elysia } from "elysia";
import { z } from "zod";

import { fanSet, FanSpeed, Mode, modeSet, powerSet, statusGet, temperatureSet } from "../core-ts/aircon.ts";
import type { Context } from "../core-ts/aircon.ts";
import { forbidden, foreignOrigin, httpBinding, openSession } from "./shared.ts";
import type { ApiOptions } from "./shared.ts";

/** The settings that `PATCH /status` changes, in this order. */
const Settings = z.object({
  power: z.boolean().optional(),
  mode: Mode.optional(),
  fan: FanSpeed.optional(),
  targetCelsius: z.number().optional(),
});

/** A call that changes one setting. */
type Change<Failure> = () => Promise<Result<null, Failure>>;

/** A case: the change of a setting when the body gives the setting, or nothing when it does not. */
const when = <Value, Failure>(value: Value | undefined, change: (value: Value) => Promise<Result<null, Failure>>): Change<Failure> | undefined =>
  value === undefined ? undefined : () => change(value);

/**
 * Make the change of each case that applies, in order, until one fails. The failure is the result. The changes before
 * it stay.
 */
async function untilFailure<Failure>(changes: readonly (Change<Failure> | undefined)[]): Promise<Result<null, Failure>> {
  for (const change of changes) {
    const result = await change?.();
    if (result?.ok === false) return result;
  }
  return ok(null);
}

/** Change each setting that the body gives, in order. */
const change = (session: Session<Context>, { power, mode, fan, targetCelsius }: z.infer<typeof Settings>) =>
  untilFailure([
    when(power, (on) => session.call(powerSet, { on })),
    when(mode, (mode) => session.call(modeSet, { mode })),
    when(fan, (speed) => session.call(fanSet, { speed })),
    when(targetCelsius, (celsius) => session.call(temperatureSet, { celsius })),
  ]);

export function elysiaApi(options: ApiOptions) {
  return new Elysia()
    .onRequest(({ request }) => (foreignOrigin(request, options) ? forbidden() : undefined))
    .error({ CallFailureError })
    .onError(({ code, error, set }) => {
      if (code !== "CallFailureError") return undefined;
      set.status = HTTP_STATUS[error.kind];
      return { kind: error.kind, message: error.message };
    })
    .mount("/api", httpBinding(options, ""))
    .get("/status", async ({ status }) => {
      await using session = openSession(options);
      const result = await session.call(statusGet, {});
      return result.ok ? result.value : status(409, result.error);
    })
    .patch(
      "/status",
      async ({ body, status }) => {
        await using session = openSession(options);
        const changed = await change(session, body);
        if (!changed.ok) return status(409, changed.error);
        const result = await session.call(statusGet, {});
        return result.ok ? result.value : status(409, result.error);
      },
      { body: Settings },
    );
}
