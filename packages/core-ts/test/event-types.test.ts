/**
 * The types of `defineEvent`, `eventsFor` and event handles. `moon run core-ts:typecheck` checks this file: each
 * `@ts-expect-error` marks a program that the types must reject.
 */
import { test } from "node:test";

import { z } from "zod";

import { createSession, defineApp, defineEvent, eventsFor } from "../src/index.ts";
import type { EventHandleOf, Occurrence } from "../src/index.ts";
import { toJsonSchema } from "./sensors.ts";

test("subscribe gets the type of its input from the input schema, and each data must agree with the payload schema", async () => {
  const event = eventsFor<{ readonly rooms: readonly string[] }>();
  const reading = event({
    id: "probe.reading",
    description: "A reading.",
    audience: ["app"],
    input: z.object({ room: z.string() }),
    payload: z.object({ celsius: z.number() }),
    async *subscribe({ room }, { context }) {
      if (context.rooms.includes(room)) yield { data: { celsius: 20 } };
    },
  });
  const tick = defineEvent({
    id: "probe.tick",
    description: "A tick.",
    audience: ["app"],
    async *subscribe(input) {
      const nothing: Record<string, never> = input;
      yield { data: nothing };
    },
  });
  const ids: readonly ["probe.reading", "probe.tick"] = [reading.id, tick.id];

  // These declarations are not used. `moon run core-ts:typecheck` checks that each one is an error.
  const wrong = [
    // @ts-expect-error The data must agree with the payload schema.
    event({ id: "probe.a", description: "x", audience: [], payload: z.object({ celsius: z.number() }), async *subscribe() { yield { data: { celsius: "hot" } }; } }),
    // @ts-expect-error `room` is a string.
    event({ id: "probe.b", description: "x", audience: [], input: z.object({ room: z.string() }), async *subscribe({ room }) { if (room === 1) yield { data: {} }; } }),
  ];

  const session = createSession(defineApp({ targets: { app: { bindings: ["typescript"] } }, capabilities: [], events: [reading, tick] }), {
    target: "app",
    context: { rooms: ["hall"] },
    toJsonSchema,
  });
  const handle: EventHandleOf<typeof reading> = session.eventHandle(reading);
  const subscribe = () => handle.subscribe({ room: "hall" });
  const first = async () => {
    for await (const occurrence of await subscribe()) {
      const typed: Occurrence<{ celsius: number }> = occurrence;
      return typed.data.celsius;
    }
    return undefined;
  };
  // @ts-expect-error The input of the handle has the type of the input schema.
  const badInput = () => handle.subscribe({ room: 1 });
  void [ids, wrong, first, badInput];
  await session.dispose();
});
