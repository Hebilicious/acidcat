import { CallFailureError, ok } from "@acid-cat/core-ts";
import type { Result, Session } from "@acid-cat/core-ts";
import { HTTP_STATUS } from "@acid-cat/spec-ts";
import { Elysia, sse } from "elysia";
import type { ElysiaConfig } from "elysia";
import { z } from "zod";

import { fanSet, FanSpeed, Mode, modeSet, powerSet, statusChanged, statusGet, temperatureSet } from "../core-ts/aircon.ts";
import type * as Types from "../catalog/aircon.types.ts";
import type { Context } from "../core-ts/aircon.ts";
import { forbidden, foreignOrigin, httpBinding, openSession } from "./shared.ts";
import type { ApiOptions } from "./shared.ts";

const Settings = z.object({
  power: z.boolean().optional(),
  mode: Mode.optional(),
  fan: FanSpeed.optional(),
  targetCelsius: z.number().optional(),
});

type ChangeFailure = Types.AirconPowerSetFailure | Types.AirconModeSetFailure | Types.AirconFanSetFailure | Types.AirconTemperatureSetFailure;

async function change(session: Session<Context>, { power, mode, fan, targetCelsius }: z.infer<typeof Settings>) {
  let result: Result<null, ChangeFailure> = ok(null);
  if (result.ok && power !== undefined) result = await session.call(powerSet, { on: power });
  if (result.ok && mode !== undefined) result = await session.call(modeSet, { mode });
  if (result.ok && fan !== undefined) result = await session.call(fanSet, { speed: fan });
  if (result.ok && targetCelsius !== undefined) result = await session.call(temperatureSet, { celsius: targetCelsius });
  return result;
}

interface Following {
  readonly session: Session<Context>;
  readonly abort: AbortController;
}

/**
 * The WebSocket needs a server adapter that serves WebSockets, for example `@elysiajs/node` on Node.js: give it as
 * `adapter`, then call `listen`.
 */
export function elysiaApi(options: ApiOptions, adapter?: ElysiaConfig<"">["adapter"]) {
  const following = new Map<string, Following>();
  return new Elysia(adapter === undefined ? {} : { adapter })
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
    )
    .get("/status/changes", async function* ({ request }) {
      await using session = openSession(options);
      // When the client goes away, the signal of the request aborts and cancels the subscription. Elysia also calls
      // `return()` of the generator, but that call waits until the `await` of the loop ends, so it alone does not stop
      // a subscription that waits for its next occurrence.
      const occurrences = await session.eventHandle(statusChanged).subscribe({}, { signal: request.signal });
      // Elysia sends the response after the first value of the generator. This first event tells the client how long
      // to wait before it connects again, and sends the response before the first change.
      yield sse({ retry: 1000 });
      for await (const occurrence of occurrences) yield sse({ event: statusChanged.id, data: occurrence.data });
    })
    .ws("/status/follow", {
      // `onRequest` refuses the upgrade request of a foreign origin with 403, so no WebSocket opens for it.
      async open(ws) {
        const session = openSession(options);
        const abort = new AbortController();
        following.set(ws.id, { session, abort });
        try {
          const occurrences = await session.eventHandle(statusChanged).subscribe({}, { signal: abort.signal });
          ws.send(JSON.stringify({ event: "following" }));
          for await (const occurrence of occurrences) ws.send(JSON.stringify({ event: statusChanged.id, data: occurrence.data }));
        } catch (error) {
          if (error instanceof CallFailureError && !abort.signal.aborted) ws.close(1011, error.kind);
        } finally {
          following.delete(ws.id);
          await session.dispose();
        }
      },
      close(ws) {
        following.get(ws.id)?.abort.abort();
      },
    });
}
