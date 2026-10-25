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
import type { Context, Offline, PoweredOff } from "../core-ts/aircon.ts";
import { forbidden, foreignOrigin, httpBinding, openSession } from "./shared.ts";
import type { ApiOptions } from "./shared.ts";

/** The settings that `PATCH /status` changes, in this order. */
const Settings = z.object({
  power: z.boolean().optional(),
  mode: Mode.optional(),
  fan: FanSpeed.optional(),
  targetCelsius: z.number().optional(),
});

/** A failure that stops a change of the settings. */
type ChangeFailure = z.infer<typeof Offline> | z.infer<typeof PoweredOff>;

/**
 * Change each setting that the body gives, in order. Each change runs only if the change before it succeeded, so the
 * first failure stops the change. The settings before it stay changed.
 */
async function change(session: Session<Context>, { power, mode, fan, targetCelsius }: z.infer<typeof Settings>) {
  let result: Result<null, ChangeFailure> = ok(null);
  if (result.ok && power !== undefined) result = await session.call(powerSet, { on: power });
  if (result.ok && mode !== undefined) result = await session.call(modeSet, { mode });
  if (result.ok && fan !== undefined) result = await session.call(fanSet, { speed: fan });
  if (result.ok && targetCelsius !== undefined) result = await session.call(temperatureSet, { celsius: targetCelsius });
  return result;
}

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
