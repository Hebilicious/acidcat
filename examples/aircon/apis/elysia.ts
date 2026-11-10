/**
 * An Elysia server for the air conditioner. It mounts the HTTP binding at `/api`, and adds its own routes:
 * `GET /status`, `PATCH /status`, which changes more than one setting in one request, `GET /status/changes`, a
 * stream of server-sent events that follows the event `aircon.status.changed`, and the WebSocket `/status/follow`,
 * which follows the same event. The WebSocket needs a server adapter that serves WebSockets, for example
 * `@elysiajs/node` on Node.js: give it as `adapter`, then call `listen`.
 *
 * Each request has its own session. `PATCH /status` checks the shape of its body with Zod, and `session.call` checks
 * each setting with the input schema of its capability. The application chooses the status codes: a failure gives
 * `409` with the failure in the body, and a call failure gives the status code of its kind.
 */
import { CallFailureError, ok } from "@acid-cat/core-ts";
import type { Result, Session } from "@acid-cat/core-ts";
import { HTTP_STATUS } from "@acid-cat/spec-ts";
import { Elysia, sse } from "elysia";
import type { ElysiaConfig } from "elysia";
import { z } from "zod";

import { fanSet, FanSpeed, Mode, modeSet, powerSet, statusChanged, statusGet, temperatureSet } from "../core-ts/aircon.ts";
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

/** A WebSocket that follows the event: its session, and the signal that cancels its subscription. */
interface Following {
  readonly session: Session<Context>;
  readonly abort: AbortController;
}

export function elysiaApi(options: ApiOptions, adapter?: ElysiaConfig<"">["adapter"]) {
  // Each WebSocket is one session. The id of the WebSocket finds its session when the connection closes.
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
      // The session of the request stays open until the stream ends.
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
          // A subscription that ends with a call failure closes the WebSocket with its kind.
          if (error instanceof CallFailureError && !abort.signal.aborted) ws.close(1011, error.kind);
        } finally {
          following.delete(ws.id);
          await session.dispose();
        }
      },
      close(ws) {
        // When the client closes the WebSocket, the subscription is cancelled, and its session closes.
        following.get(ws.id)?.abort.abort();
      },
    });
}
