/** The fixture, except that `fixture.hold` ignores cancellation: it ends only when fixture.release releases it. */
import { Effect } from "effect";

import type { App, Capability } from "../src/index.ts";
import { fixture } from "./fixture.ts";
import type { Holds, Switch } from "./fixture.ts";

export const fixtureIgnoringCancellation: App.App<Holds | Switch> = {
  ...fixture,
  capabilities: fixture.capabilities.map(
    (capability): Capability.Any<Holds | Switch> =>
      capability.id === "fixture.hold" ? { ...capability, run: (input) => Effect.uninterruptible(capability.run(input)) } : capability,
  ),
};

/** The fixture, except that `fixture.echo` never answers. */
export const fixtureNeverAnswering: App.App<Holds | Switch> = {
  ...fixture,
  capabilities: fixture.capabilities.map(
    (capability): Capability.Any<Holds | Switch> => (capability.id === "fixture.echo" ? { ...capability, run: () => Effect.never } : capability),
  ),
};
