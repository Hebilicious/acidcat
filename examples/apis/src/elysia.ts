/**
 * An Elysia server for the air conditioner. It mounts the HTTP binding at `/api`, and adds its own routes:
 * `GET /status`, and `PATCH /status`, which changes more than one setting in one request.
 *
 * The routes validate their bodies with the Zod schemas of the application. A failure gives the status code that the
 * application chooses: `409` with the failure in the body.
 */
import { CallFailureError } from "@acid-cat/core-ts";
import { HTTP_STATUS } from "@acid-cat/spec-ts";
import { Elysia } from "elysia";
import { z } from "zod";

import { apiSession, Failure, FanSpeed, forbidden, foreignOrigin, httpBinding, Mode, status, value } from "./aircon.ts";
import type { ApiOptions } from "./aircon.ts";

/** The settings that `PATCH /status` changes, in this order. */
const Settings = z.object({
  power: z.boolean().optional(),
  mode: Mode.optional(),
  fan: FanSpeed.optional(),
  targetCelsius: z.number().optional(),
});

export function elysiaApi(options: ApiOptions) {
  const session = apiSession(options);
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
    .get("/status", () => status(session))
    .patch(
      "/status",
      async ({ body }) => {
        if (body.power !== undefined) await value(session, "aircon.power.set", { on: body.power });
        if (body.mode !== undefined) await value(session, "aircon.mode.set", { mode: body.mode });
        if (body.fan !== undefined) await value(session, "aircon.fan.set", { speed: body.fan });
        if (body.targetCelsius !== undefined) await value(session, "aircon.temperature.set", { celsius: body.targetCelsius });
        return status(session);
      },
      { body: Settings },
    );
}
