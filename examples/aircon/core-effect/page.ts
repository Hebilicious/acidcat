import { AVAILABLE, unavailable } from "@acid-cat/spec-ts";
import { Effect, FiberSet, Option, Schema, Stream, SubscriptionRef } from "effect";

import { Session, WebMcp } from "@acid-cat/core-effect";

import { bindPage } from "../web/controls.ts";
import { aircon, fanSet, firmwareUpdate, modeSet, powerSet, Status, statusGet, temperatureSet, Unit, unitLayer } from "./aircon.ts";

const program = Effect.gen(function* () {
  const unit = yield* Unit;
  const session = yield* Session.make(aircon, { target: "app" });
  const run = yield* FiberSet.makeRuntimePromise<never>();

  const controls = bindPage("@acid-cat/core-effect", {
    power: (on) => run(session.invoke(powerSet.id, { on })),
    mode: (mode) => run(session.invoke(modeSet.id, { mode })),
    temperature: (celsius) => run(session.invoke(temperatureSet.id, { celsius })),
    fan: (speed) => run(session.invoke(fanSet.id, { speed })),
    firmware: () => run(session.invoke(firmwareUpdate.id, {})),
    online: (online) => void run(SubscriptionRef.set(unit.connection, online ? AVAILABLE : unavailable("The unit is offline."))),
  });

  yield* session.state(statusGet.id).pipe(
    Stream.mapEffect((value) => Schema.decodeUnknownEffect(Status)(value)),
    Stream.runForEach((status) => Effect.sync(() => controls.showStatus(status))),
    Effect.forkScoped,
  );

  const ids = Object.keys(session.catalog.capabilities);
  const showTools = Effect.gen(function* () {
    const tools = yield* Effect.forEach(ids, (id) =>
      Effect.map(session.availability(id), (availability) => ({
        id,
        available: availability.available,
        reason: availability.available ? undefined : availability.reason,
      })),
    );
    controls.showTools(tools);
  });
  yield* showTools;
  yield* session.changes.pipe(Stream.runForEach(() => showTools), Effect.forkScoped);

  const installation = yield* WebMcp.install(session);
  if (Option.isNone(installation)) {
    controls.showToolStatus(undefined);
  } else {
    yield* SubscriptionRef.changes(installation.value.status).pipe(
      Stream.runForEach((status) => Effect.sync(() => controls.showToolStatus(status))),
      Effect.forkScoped,
    );
  }
  return yield* Effect.never;
});

Effect.runFork(program.pipe(Effect.scoped, Effect.provide(unitLayer)));
