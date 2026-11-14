/**
 * The web page of the air conditioner on @acid-cat/core-ts, in the browser. It opens a session of the target `app`,
 * shows the status, calls the capabilities from its controls, and installs the WebMCP binding: a browser agent gets one
 * tool for each capability of the view that is available. `serve-page.ts` bundles and serves it.
 */
import { createSession, installWebMcp } from "@acid-cat/core-ts";
import type { Result } from "@acid-cat/core-ts";
import type { Outcome } from "@acid-cat/spec-ts";

import { bindPage, callFailureOf } from "../web/controls.ts";
import { aircon, fanSet, firmwareUpdate, modeSet, powerSet, statusGet, temperatureSet, toJsonSchema, Unit } from "./aircon.ts";

const unit = new Unit();
const session = createSession(aircon, { target: "app", context: { unit }, toJsonSchema });

/** The outcome of a typed call: its result, or the call failure that it rejects with. */
const outcome = (call: Promise<Result<unknown, unknown>>): Promise<Outcome<unknown, unknown>> => call.catch(callFailureOf);

const view = bindPage("@acid-cat/core-ts", {
  // The values of the controls are not trusted: `call` checks each input with the input schema of the capability.
  power: (on) => outcome(session.call(powerSet, { on })),
  mode: (mode) => outcome(session.call(modeSet, { mode })),
  temperature: (celsius) => outcome(session.call(temperatureSet, { celsius })),
  fan: (speed) => outcome(session.call(fanSet, { speed })),
  firmware: () => outcome(session.call(firmwareUpdate, {})),
  online: (online) => unit.change({ online }),
});

// The status, through the state of `aircon.status.get`.
const status = session.handle(statusGet).snapshot;
if (status !== undefined) {
  view.showStatus(status.getSnapshot());
  status.subscribe(view.showStatus);
}

// The availability of each capability of the view. The WebMCP binding registers a tool for each one that is available.
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
