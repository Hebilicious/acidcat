import { createSession, installWebMcp } from "@acid-cat/core-ts";
import type { Result } from "@acid-cat/core-ts";
import type { Outcome } from "@acid-cat/spec-ts";

import { bindPage, callFailureOf } from "../web/controls.ts";
import { aircon, fanSet, firmwareUpdate, modeSet, powerSet, statusGet, temperatureSet, toJsonSchema, Unit } from "./aircon.ts";

const unit = new Unit();
const session = createSession(aircon, { target: "app", context: { unit }, toJsonSchema });

const outcome = (call: Promise<Result<unknown, unknown>>): Promise<Outcome<unknown, unknown>> => call.catch(callFailureOf);

const view = bindPage("@acid-cat/core-ts", {
  power: (on) => outcome(session.call(powerSet, { on })),
  mode: (mode) => outcome(session.call(modeSet, { mode })),
  temperature: (celsius) => outcome(session.call(temperatureSet, { celsius })),
  fan: (speed) => outcome(session.call(fanSet, { speed })),
  firmware: () => outcome(session.call(firmwareUpdate, {})),
  online: (online) => unit.change({ online }),
});

const status = session.handle(statusGet).snapshot;
if (status !== undefined) {
  view.showStatus(status.getSnapshot());
  status.subscribe(view.showStatus);
}

const showTools = () =>
  view.showTools(
    [...session.handles.values()].map((handle) => {
      const availability = handle.availability.getSnapshot();
      return { id: handle.id, available: availability.available, reason: availability.available ? undefined : availability.reason };
    }),
  );
showTools();
session.onChange(showTools);

const webmcp = installWebMcp(session);
view.showToolStatus(webmcp?.status.getSnapshot());
webmcp?.status.subscribe(view.showToolStatus);
