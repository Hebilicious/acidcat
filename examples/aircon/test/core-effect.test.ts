import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { test } from "node:test";

import { check } from "@acid-cat/cli";
import { Effect, Fiber, Layer, Schema, Stream } from "effect";

import { aircon, statusChanged, unitLayer } from "../core-effect/aircon.ts";
import { App, Mcp, Session } from "@acid-cat/core-effect";
import { run } from "./run.ts";
import type { Run } from "./run.ts";
import { shape, writtenText } from "./shape.ts";

/** The part of a `tools/list` response that the test reads. */
const ToolList = Schema.Struct({ result: Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }) });

test("the code writes a catalog that conforms and agrees with the Pkl catalog", () => {
  const text = App.render(aircon);
  assert.deepEqual(check(JSON.parse(text), text).errors, []);
  assert.deepEqual(shape(App.document(aircon)), shape(JSON.parse(writtenText)));
});

test("the unit works through a session", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* Session.make(aircon, { target: "mcp" });
        assert.deepEqual(yield* session.invoke("aircon.mode.set", { mode: "heat" }), { ok: false, error: { _tag: "PoweredOff" } });
        assert.deepEqual(yield* session.invoke("aircon.power.set", { on: true }), { ok: true, value: null });
        assert.deepEqual(yield* session.invoke("aircon.mode.set", { mode: "heat" }), { ok: true, value: null });
        const invalid = yield* session.invoke("aircon.temperature.set", { celsius: 40 });
        assert.equal("kind" in invalid && invalid.kind, "invalid-input");
        const [state] = yield* session.state("aircon.status.get").pipe(Stream.take(1), Stream.runCollect);
        assert.deepEqual(state, { power: true, mode: "heat", fan: "auto", targetCelsius: 22, roomCelsius: 25 });
        const status = yield* session.invoke("aircon.status.get", {});
        assert.deepEqual(status, { ok: true, value: { power: true, mode: "heat", fan: "auto", targetCelsius: 22, roomCelsius: 25 } });
      }),
    ).pipe(Effect.provide(Layer.fresh(unitLayer))),
  ));

test("aircon.status.changed gives the new status after each change, and nothing for a change to the same status", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* Session.make(aircon, { target: "app" });
        const changes = yield* session.follow(statusChanged, {});
        const occurrences = yield* changes.pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped({ startImmediately: true }));
        yield* session.invoke("aircon.power.set", { on: true });
        yield* session.invoke("aircon.power.set", { on: true });
        yield* session.invoke("aircon.fan.set", { speed: "high" });
        const [power, fan] = yield* Fiber.join(occurrences);
        assert.equal(power?.name, "aircon.status.changed");
        assert.deepEqual(power?.data, { power: true, mode: "cool", fan: "auto", targetCelsius: 22, roomCelsius: 25 });
        assert.deepEqual(fan?.data, { power: true, mode: "cool", fan: "high", targetCelsius: 22, roomCelsius: 25 });
      }),
    ).pipe(Effect.provide(Layer.fresh(unitLayer))),
  ));

test("an agent sees the mcp view through MCP", async () => {
  const handler = Mcp.toWebHandler(aircon, unitLayer, { name: "aircon", version: "0.1.0", allowedOrigins: [] });
  const response = await handler(
    new Request("https://unit.local/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-method": "tools/list", "mcp-protocol-version": "2026-07-28" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } }),
    }),
  );
  const { result } = Schema.decodeUnknownSync(ToolList)(await response.json());
  const tools = result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(tools, ["aircon.fan.set", "aircon.mode.set", "aircon.power.set", "aircon.schedule.set", "aircon.status.get", "aircon.temperature.set"]);
});

test("a flag follows a $ref to its type", async () => {
  const cli = (...args: string[]) => run(new URL("../core-effect/cli.ts", import.meta.url).pathname, ...args);
  const [poweredOff, unknownMode] = await Promise.all([cli("aircon", "mode", "set", "--mode", "heat"), cli("aircon", "mode", "set", "--mode", "boil")]);
  assert.equal(poweredOff.code, 1);
  assert.deepEqual(JSON.parse(poweredOff.stdout), { _tag: "PoweredOff" });
  assert.equal(unknownMode.code, 3);
});

test("an array input takes one repeated flag for each item, or JSON text of the array", async () => {
  const cli = (...args: string[]) => run(new URL("../core-effect/cli.ts", import.meta.url).pathname, ...args);
  const [schedule, once, jsonText, notADay, notAnHour, list] = await Promise.all([
    cli("aircon", "schedule", "set", "--days", "mon", "--days", "fri", "--hours", "7", "--hours=18"),
    cli("aircon", "schedule", "set", "--days", "sat"),
    cli("aircon", "schedule", "set", "--days", '["tue","thu"]', "--hours", "[6]"),
    cli("aircon", "schedule", "set", "--days", '["noon"]'),
    cli("aircon", "schedule", "set", "--days", "mon", "--hours", "24"),
    cli("list"),
  ]);
  assert.equal(schedule.code, 0);
  assert.deepEqual(JSON.parse(schedule.stdout), { days: ["mon", "fri"], hours: [7, 18] });
  assert.deepEqual(JSON.parse(once.stdout), { days: ["sat"], hours: [7] });
  assert.deepEqual(JSON.parse(jsonText.stdout), { days: ["tue", "thu"], hours: [6] });
  assert.equal(notADay.code, 3);
  assert.equal(notAnHour.code, 3);
  assert.match(list.stdout, /"usage": "aircon aircon schedule set --days <mon\|tue\|wed\|thu\|fri\|sat\|sun>\.\.\. \[--hours <integer>\.\.\.\]"/);
});

test("the state gives the current value, then each change", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* Session.make(aircon, { target: "app" });
        const values = yield* session.state("aircon.status.get").pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped({ startImmediately: true }));
        yield* session.invoke("aircon.power.set", { on: true });
        const [first, second] = yield* Fiber.join(values).pipe(Effect.timeout(1000));
        const off = { power: false, mode: "cool", fan: "auto", targetCelsius: 22, roomCelsius: 25 };
        assert.deepEqual([first, second], [off, { ...off, power: true }]);
        assert.deepEqual(yield* session.state("aircon.power.set").pipe(Stream.runCollect), []);
      }),
    ).pipe(Effect.provide(Layer.fresh(unitLayer))),
  ));

/** The exit code and the output of a program when it exits. */
function finish(child: ChildProcessByStdio<null, Readable, Readable>): Promise<Run> {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf-8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf-8").on("data", (chunk: string) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("the Effect command line controls the unit of a server, and watch follows its changes", async (context) => {
  const cliPath = new URL("../core-effect/cli.ts", import.meta.url).pathname;
  const server = spawn(process.execPath, [new URL("../core-effect/serve.ts", import.meta.url).pathname], { stdio: ["ignore", "pipe", "inherit"] });
  context.after(() => server.kill());
  const url = await new Promise<string>((resolve, reject) => {
    server.on("error", reject);
    server.stdout.setEncoding("utf-8").once("data", (chunk: string) => resolve(chunk.trim()));
  });
  // With AIRCON_URL, the command line sends each call and each subscription to the server.
  const remote = (...args: string[]) =>
    spawn(process.execPath, [cliPath, ...args], { env: { ...process.env, AIRCON_URL: url }, stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });

  assert.equal((await finish(remote("aircon", "power", "set", "--on"))).code, 0);
  const status = await finish(remote("aircon", "status", "get"));
  assert.equal(status.code, 0);
  assert.partialDeepStrictEqual(JSON.parse(status.stdout), { power: true });
  // The unit of the server changed, not the unit of a new process.
  assert.partialDeepStrictEqual(JSON.parse((await run(cliPath, "aircon", "status", "get")).stdout), { power: false });

  const watch = remote("watch", "aircon.status.changed");
  let watched = "";
  watch.stdout.setEncoding("utf-8").on("data", (chunk: string) => (watched += chunk));
  // Change the fan until the subscription writes its first occurrence: a change before the subscription starts is not
  // in it.
  for (let turn = 0; !watched.includes("\n"); turn++) {
    assert.ok(turn < 100, "watch writes an occurrence");
    assert.equal((await finish(remote("aircon", "fan", "set", "--speed", turn % 2 === 0 ? "low" : "high"))).code, 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const line = watched.slice(0, watched.indexOf("\n"));
  assert.partialDeepStrictEqual(JSON.parse(line), { name: "aircon.status.changed", data: { power: true } });
  assert.match(line, /"fan":"(low|high)"/);
  const exited = new Promise<number | null>((resolve) => watch.on("close", resolve));
  watch.kill("SIGINT");
  assert.equal(await exited, 130);
});
