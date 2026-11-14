/**
 * The web page of the air conditioner on @acid-cat/core-effect, in the browser, fully in Effect. The program opens a
 * session of the target `app`, shows the status, calls the capabilities from the controls, and installs the WebMCP
 * binding: a browser agent gets one tool for each capability of the view that is available. The tools stay while the
 * page is open. `serve-page.ts` bundles and serves it.
 */
import { AVAILABLE, unavailable } from "@acid-cat/spec-ts";
import { Effect, FiberSet, Option, Schema, Stream, SubscriptionRef } from "effect";

import { Session, WebMcp } from "@acid-cat/core-effect";

import { bindPage } from "../web/controls.ts";
import { aircon, fanSet, firmwareUpdate, modeSet, powerSet, Status, statusGet, temperatureSet, Unit, unitLayer } from "./aircon.ts";

const program = Effect.gen(function* () {
  const unit = yield* Unit;
  const session = yield* Session.make(aircon, { target: "app" });
  const run = yield* FiberSet.makeRuntimePromise<never>();

  // The values of the controls are not trusted: `invoke` decodes each input with the input schema of the capability. It
  // gives the value, the failure or the call failure, in its JSON form, and never fails.
  const view = bindPage("@acid-cat/core-effect", {
    power: (on) => run(session.invoke(powerSet.id, { on })),
    mode: (mode) => run(session.invoke(modeSet.id, { mode })),
    temperature: (celsius) => run(session.invoke(temperatureSet.id, { celsius })),
    fan: (speed) => run(session.invoke(fanSet.id, { speed })),
    firmware: () => run(session.invoke(firmwareUpdate.id, {})),
    online: (online) => void run(SubscriptionRef.set(unit.connection, online ? AVAILABLE : unavailable("The unit is offline."))),
  });

  // The status, through the state of `aircon.status.get`, in its JSON form.
  yield* session.state(statusGet.id).pipe(
    Stream.mapEffect((value) => Schema.decodeUnknownEffect(Status)(value)),
    Stream.runForEach((status) => Effect.sync(() => view.showStatus(status))),
    Effect.forkScoped,
  );

  // The availability of each capability of the view. The WebMCP binding registers a tool for each one that is available.
  const ids = Object.keys(session.view.capabilities);
  const showTools = Effect.gen(function* () {
    const tools = yield* Effect.forEach(ids, (id) =>
      Effect.map(session.availability(id), (availability) => ({
        id,
        available: availability.available,
        reason: availability.available ? undefined : availability.reason,
      })),
    );
    view.showTools(tools);
  });
  yield* showTools;
  yield* session.changes.pipe(Stream.runForEach(() => showTools), Effect.forkScoped);

  const installation = yield* WebMcp.install(session);
  if (Option.isNone(installation)) {
    view.showToolStatus(undefined);
  } else {
    yield* SubscriptionRef.changes(installation.value.status).pipe(
      Stream.runForEach((status) => Effect.sync(() => view.showToolStatus(status))),
      Effect.forkScoped,
    );
  }
  return yield* Effect.never;
});

Effect.runFork(program.pipe(Effect.scoped, Effect.provide(unitLayer)));
