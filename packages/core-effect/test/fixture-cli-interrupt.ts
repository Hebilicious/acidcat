/**
 * A command line whose call interrupts its own process before the program first waits, to test that an interrupt at
 * that time cancels the call.
 */
import { Effect, Layer } from "effect";

import { App, Capability } from "../src/index.ts";
import { NodeCli } from "../src/node.ts";

const app = App.make({
  targets: { cli: { bindings: ["cli"] } },
  capabilities: [
    Capability.make({
      id: "probe.interrupt",
      description: "Send SIGINT to this process, then wait.",
      audience: ["cli"],
      run: () => Effect.sync(() => process.kill(process.pid, "SIGINT")).pipe(Effect.andThen(Effect.never)),
    }),
  ],
});

NodeCli.main(app, Layer.empty, { name: "probe", version: "0.0.0" });
