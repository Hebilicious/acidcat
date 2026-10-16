/**
 * The types of `defineCapability` and `capabilitiesFor`. `moon run core-ts:typecheck` checks this file: each
 * `@ts-expect-error` marks a program that the types must reject.
 */
import { test } from "node:test";

import { capabilitiesFor, defineCapability, ok } from "../src/index.ts";

test("defineCapability and capabilitiesFor keep the literal id", () => {
  const find = defineCapability({ id: "probe.find", description: "Find a record.", audience: ["mcp"], run: () => ok(null) });
  const capability = capabilitiesFor<{ readonly store: Map<string, string> }>();
  const save = capability({ id: "probe.save", description: "Save a record.", audience: ["mcp"], run: () => ok(null) });

  const ids: readonly ["probe.find", "probe.save"] = [find.id, save.id];
  // @ts-expect-error The id is "probe.find".
  const other: "probe.load" = find.id;
  void [ids, other];
});
