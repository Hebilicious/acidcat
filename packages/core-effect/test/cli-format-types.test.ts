import { test } from "node:test";
import { Effect, Schema, Stream } from "effect";

import { App, Capability, Event } from "../src/index.ts";

const Status = Schema.Struct({ power: Schema.Boolean });
const Offline = Schema.TaggedStruct("Offline", { since: Schema.optional(Schema.String) });

const status = Capability.make({
  id: "probe.status",
  description: "Read the status of the probe.",
  audience: ["cli"],
  output: Status,
  failures: [Offline],
  run: () => Effect.succeed({ power: true }),
});

const plain = Capability.make({ id: "probe.plain", description: "Read the plain value of the probe.", audience: ["cli"], output: Status, run: () => Effect.succeed({ power: true }) });

const changed = Event.make({ id: "probe.changed", description: "The status changed.", audience: ["cli"], payload: Status, subscribe: () => Stream.empty });

test("a format gets the value, each failure and the payload in their types", () => {
  const wrong = () => [
    // @ts-expect-error The value of probe.status has no property powr.
    App.format(status, (value) => String(value.powr)),
    // @ts-expect-error probe.status has no failure with the tag Ofline.
    App.format(status, { failures: { Ofline: () => "offline" } }),
    // @ts-expect-error probe.plain has no failures.
    App.format(plain, { failures: { Bogus: () => "x" } }),
    // @ts-expect-error The failure Offline has no property until.
    App.format(status, { failures: { Offline: (failure) => String(failure.until) } }),
    // @ts-expect-error The payload of probe.changed has no property powr.
    App.format(changed, (payload) => String(payload.powr)),
  ];
  const typed = App.format(status, { value: ({ power }) => String(power), failures: { Offline: ({ since }) => since ?? "" } });
  void [wrong, typed];
});
