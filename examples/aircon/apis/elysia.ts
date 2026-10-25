/**
 * An Elysia server for the air conditioner. It mounts the HTTP binding at `/api`, and adds its own routes:
 * `GET /status`, and `PATCH /status`, which changes more than one setting in one request.
 *
 * Each request has its own session. `PATCH /status` checks the shape of its body with Zod, and `session.call` checks
 * each setting with the input schema of its capability. The application chooses the status codes: a failure gives
 * `409` with the failure in the body, and a call failure gives the status code of its kind.
 */
import { CallFailureError } from "@acid-cat/core-ts";
import type { Session } from "@acid-cat/core-ts";
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

/** The calls that change the settings that the body gives, in order. */
function changes(session: Session<Context>, { power, mode, fan, targetCelsius }: z.infer<typeof Settings>) {
  return [
    ...(power === undefined ? [] : [() => session.call(powerSet, { on: power })]),
    ...(mode === undefined ? [] : [() => session.call(modeSet, { mode })]),
    ...(fan === undefined ? [] : [() => session.call(fanSet, { speed: fan })]),
    ...(targetCelsius === undefined ? [] : [() => session.call(temperatureSet, { celsius: targetCelsius })]),
  ];
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
    .get("/status", async ({ set }) => {
      await using session = openSession(options);
      const status = await session.call(statusGet, {});
      if (status.ok) return status.value;
      set.status = 409;
      return status.error;
    })
    .patch(
      "/status",
      async ({ body, set }) => {
        await using session = openSession(options);
        // The first failure stops the request. The settings before it stay changed.
        for (const change of changes(session, body)) {
          const result = await change();
          if (!result.ok) {
            set.status = 409;
            return result.error;
          }
        }
        const status = await session.call(statusGet, {});
        if (status.ok) return status.value;
        set.status = 409;
        return status.error;
      },
      { body: Settings },
    );
}
