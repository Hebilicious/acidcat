/** A command line with two lazy capabilities: one loads, and the module of the other always fails. */
import { Layer } from "effect";

import { App, Capability } from "../src/index.ts";
import { NodeCli } from "../src/node.ts";

const generate = Capability.lazy(
  { id: "plan.generate", description: "Make a plan with some stops.", audience: ["app", "mcp", "cli", "api"], readOnly: true },
  async () => (await import("./lazy-probe.capability.ts")).generate,
);

const broken = Capability.lazy({ id: "plan.list", description: "List the plans.", audience: ["cli"], readOnly: true }, async () => {
  throw new Error("This module does not load.");
});

const app = App.make({ targets: { cli: { bindings: ["cli"] } }, capabilities: [generate, broken] });

NodeCli.main(app, Layer.empty, { name: "probe", version: "1.2.3" });
