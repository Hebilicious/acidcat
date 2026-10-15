import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect, Schema } from "effect";
import { Command, Flag, GlobalFlag } from "effect/cli";

import { App, Capability, Cli } from "../src/index.ts";
import { fixture } from "./fixture.ts";

const options = { name: "fixture", version: "0.0.0" };

test("two commands with the same path stop the program when it starts", () => {
  for (const name of ["fixture", "list", "call"]) {
    assert.throws(() => Cli.command(fixture, { ...options, commands: [Command.make(name)] }), /Two commands of the command line have the path fixture/);
  }
  assert.throws(
    () => Cli.command(fixture, { ...options, commands: [Command.make("solve"), Command.make("solve")] }),
    /Two commands of the command line have the path fixture solve/,
  );
});

test("a flag of a capability with the name of a global flag stops the program when it starts", () => {
  const text = GlobalFlag.Setting("text")({ flag: Flag.String("text").pipe(Flag.optional) });
  assert.throws(() => Cli.command(fixture, { ...options, globalFlags: [text] }), /The flag --text of fixture.echo has the same name as a global flag/);

  const helpful = App.make({
    targets: { cli: { bindings: ["cli"] } },
    capabilities: [
      Capability.make({
        id: "probe.ask",
        description: "Ask for help.",
        audience: ["cli"],
        input: Schema.Struct({ help: Schema.Boolean }),
        run: () => Effect.succeed(null),
      }),
    ],
  });
  assert.throws(() => Cli.command(helpful, options), /The flag --help of probe.ask has the same name as a global flag/);
});
