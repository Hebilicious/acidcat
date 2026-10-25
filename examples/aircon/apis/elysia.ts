/**
 * An Elysia server for the air conditioner. It mounts the HTTP binding at `/api`, and adds its own routes:
 * `GET /status`, and `PATCH /status`, which changes more than one setting in one request.
 *
 * Each request has its own session. `PATCH /status` checks the shape of its body with Zod, then checks each setting
 * with the input schema of its capability, and makes a typed call. A failure gives the status code that the
 * application chooses: `409` with the failure in the body.
 */
import { CallFailureError, getHandle } from "@acid-cat/core-ts";
import type { Session } from "@acid-cat/core-ts";
import { HTTP_STATUS } from "@acid-cat/spec-ts";
import { Elysia } from "elysia";
import { z } from "zod";

import { FanInput, fanSet, FanSpeed, Mode, ModeInput, modeSet, PowerInput, powerSet, statusGet, TemperatureInput, temperatureSet } from "../core-ts/aircon.ts";
import { decode, Failure, forbidden, foreignOrigin, httpBinding, value, withSession } from "./shared.ts";
import type { ApiOptions } from "./shared.ts";

/** The settings that `PATCH /status` changes, in this order. */
const Settings = z.object({
  power: z.boolean().optional(),
  mode: Mode.optional(),
  fan: FanSpeed.optional(),
  targetCelsius: z.number().optional(),
});

const status = (session: Session) => value(getHandle(session.handles, statusGet).execute({}));

/** Change each setting that `settings` gives, then give the new status. */
async function change(session: Session, settings: z.infer<typeof Settings>) {
  const { handles } = session;
  if (settings.power !== undefined) await value(getHandle(handles, powerSet).execute(decode(PowerInput, { on: settings.power })));
  if (settings.mode !== undefined) await value(getHandle(handles, modeSet).execute(decode(ModeInput, { mode: settings.mode })));
  if (settings.fan !== undefined) await value(getHandle(handles, fanSet).execute(decode(FanInput, { speed: settings.fan })));
  if (settings.targetCelsius !== undefined) {
    await value(getHandle(handles, temperatureSet).execute(decode(TemperatureInput, { celsius: settings.targetCelsius })));
  }
  return status(session);
}

export function elysiaApi(options: ApiOptions) {
  return new Elysia()
    .onRequest(({ request }) => (foreignOrigin(request, options) ? forbidden() : undefined))
    .error({ Failure, CallFailureError })
    .onError(({ code, error, set }) => {
      if (code === "Failure") {
        set.status = 409;
        return error.failure;
      }
      if (code === "CallFailureError") {
        set.status = HTTP_STATUS[error.kind];
        return { kind: error.kind, message: error.message };
      }
      return undefined;
    })
    .mount("/api", httpBinding(options, ""))
    .get("/status", () => withSession(options, status))
    .patch("/status", ({ body }) => withSession(options, (session) => change(session, body)), { body: Settings });
}
