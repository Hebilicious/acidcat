import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { test } from "node:test";

import { check } from "@acid-cat/cli";
import { App, Cli, Session } from "@acid-cat/core-effect";
import { unavailable } from "@acid-cat/spec-ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, Fiber, Layer, Stdio, Stream, SubscriptionRef } from "effect";

import { aircon, Files, statusChanged, Unit, unitLayer } from "../core-effect/aircon.ts";
import { output } from "../core-effect/output.ts";
import { bundledProgram } from "./bundled-program.ts";
import { assertHelp } from "./help.ts";
import { OFFLINE, SCHEDULE_LAYOUT, STATUS_OFF, STATUS_ON } from "./human.ts";
import { run } from "./run.ts";
import { firstLine, startServer, subscriptionProxy } from "./server.ts";
import type { Run } from "./run.ts";
import { shape, writtenText } from "./shape.ts";

const cliPath = bundledProgram("core-effect/cli.ts");

const OFF = { power: false, mode: "cool", fan: "auto", targetCelsius: 22, roomCelsius: 25 };

test("the code writes a catalog that conforms and agrees with the Pkl catalog", () => {
  const text = App.render(aircon);
  assert.deepEqual(check(JSON.parse(text), text), { errors: [], warnings: [] });
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
        assert.deepEqual(yield* session.invoke("aircon.schedule.set", { days: ["sat"] }), { ok: true, value: { days: ["sat"], hours: [7] } }, "the default hour is 7");
        for (const input of [{ days: ["noon"] }, { days: ["mon"], hours: [24] }]) {
          const outside = yield* session.invoke("aircon.schedule.set", input);
          assert.equal("kind" in outside && outside.kind, "invalid-input", JSON.stringify(input));
        }
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

test("the command line runs a capability, and a flag follows a $ref to its type", async () => {
  const [status, poweredOff] = await Promise.all([run(cliPath, "aircon", "status", "get"), run(cliPath, "aircon", "mode", "set", "--mode", "heat")]);
  assert.equal(status.code, 0);
  assert.deepEqual(JSON.parse(status.stdout), OFF);
  assert.equal(poweredOff.code, 1);
  assert.deepEqual(JSON.parse(poweredOff.stdout), { _tag: "PoweredOff" });
});

test("the state gives the current value, then each change", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* Session.make(aircon, { target: "app" });
        const values = yield* session.state("aircon.status.get").pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped({ startImmediately: true }));
        yield* session.invoke("aircon.power.set", { on: true });
        const [first, second] = yield* Fiber.join(values).pipe(Effect.timeout(1000));
        assert.deepEqual([first, second], [OFF, { ...OFF, power: true }]);
        assert.deepEqual(yield* session.state("aircon.power.set").pipe(Stream.runCollect), []);
      }),
    ).pipe(Effect.provide(Layer.fresh(unitLayer))),
  ));

const withArgs = (args: readonly string[]) => Layer.effect(Stdio.Stdio, Effect.map(Effect.service(Stdio.Stdio), (stdio) => ({ ...stdio, args: Effect.succeed(args) })));

const inProcess = (args: readonly string[], stdoutIsTerminal = false) =>
  Effect.gen(function* () {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const captured = { ...console, log: (text: string) => stdout.push(text), error: (text: string) => stderr.push(text) };
    const before = process.exitCode;
    process.exitCode = 0;
    yield* Cli.run(aircon, { name: "aircon", version: "0.1.0", output }).pipe(
      Effect.provideService(Console.Console, captured),
      Effect.provideService(Cli.Terminal, { stdoutIsTerminal, environment: { NO_COLOR: "1" } }),
      Effect.provide(Layer.provideMerge(withArgs(args), NodeServices.layer)),
    );
    const code = process.exitCode;
    process.exitCode = before;
    return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  });

const freshUnit = Layer.merge(Layer.fresh(unitLayer), Layer.succeed(Files, { writeFile: async () => undefined }));

test("each alias of the command line calls its capability with its fixed input", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const unit = yield* Unit;
      const status = () => SubscriptionRef.get(unit.status);
      assert.equal((yield* inProcess(["--on"])).code, 0);
      assert.equal((yield* status()).power, true);
      assert.partialDeepStrictEqual(JSON.parse((yield* inProcess(["status"])).stdout), { power: true });
      assert.equal((yield* inProcess(["--off"])).code, 0);
      assert.equal((yield* status()).power, false);
      assert.partialDeepStrictEqual(JSON.parse((yield* inProcess([])).stdout), { power: false }, "the default alias is status");
      assert.equal((yield* inProcess(["fan", "high"])).code, 0);
      assert.equal((yield* status()).fan, "high");
      assert.equal((yield* inProcess(["fan", "auto"])).code, 0);
      assert.equal((yield* status()).fan, "auto");
      assert.equal((yield* inProcess(["fan", "--speed", "low"])).code, 0);
      assert.equal((yield* status()).fan, "low");
      assert.equal((yield* inProcess(["aircon", "power", "--on"])).code, 0);
      assert.equal((yield* status()).power, true);
    }).pipe(Effect.provide(freshUnit)),
  ));

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

test("the command line controls the unit of a server, and watch and follow write its changes", async (context) => {
  const url = await startServer(context, process.execPath, [bundledProgram("core-effect/serve.ts")]);
  const client = (target: string) => (...args: string[]) =>
    spawn(process.execPath, [cliPath, ...args], { env: { ...process.env, AIRCON_URL: target }, stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
  const remote = client(url);

  assert.equal((await finish(remote("aircon", "power", "set", "--on"))).code, 0);
  const status = await finish(remote("aircon", "status", "get"));
  assert.equal(status.code, 0);
  assert.partialDeepStrictEqual(JSON.parse(status.stdout), { power: true });
  assert.partialDeepStrictEqual(JSON.parse((await run(cliPath, "aircon", "status", "get")).stdout), { power: false });
  assert.equal((await finish(remote("--output", "human", "aircon", "status", "get"))).stdout, `${STATUS_ON}\n`);

  const proxy = await subscriptionProxy(context, url);
  const watcher = client(proxy.url);
  const watch = watcher("watch", "aircon.status.changed");
  const lines = Promise.all([firstLine(watch, context), firstLine(watcher("--output", "human", "watch", "aircon.status.changed"), context), firstLine(watcher("follow"), context)]);
  await proxy.started(3);
  assert.equal((await finish(remote("aircon", "fan", "set", "--speed", "high"))).code, 0);
  const [line, human, followed] = await lines;
  assert.partialDeepStrictEqual(JSON.parse(line), { name: "aircon.status.changed", data: { power: true, fan: "high" } });
  assert.equal(human, "on · cool · fan high · target 22°C · room 25°C");
  assert.partialDeepStrictEqual(JSON.parse(followed), { name: "aircon.status.changed", data: { fan: "high" } });
  const exited = new Promise<number | null>((resolve) => watch.on("close", resolve));
  watch.kill("SIGINT");
  assert.equal(await exited, 130);
});

test("aircon.status.export writes a file through the command line", async (context) => {
  const folder = await mkdtemp(join(tmpdir(), "aircon-"));
  context.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, "status.json");
  assert.equal((await run(cliPath, "aircon", "status", "export", "--path", file)).code, 0);
  assert.partialDeepStrictEqual(JSON.parse(await readFile(file, "utf-8")), { power: false });
});

const offline = Layer.effectDiscard(Effect.flatMap(Effect.service(Unit), (unit) => SubscriptionRef.set(unit.connection, unavailable("The unit is offline."))));

test("the command line writes the human form with its output flags, and on a terminal by default", async () => {
  const [status, schedule, list, unknown] = await Promise.all([
    run(cliPath, "status", "--output", "human"),
    run(cliPath, "aircon", "schedule", "set", "--days", "mon", "--days", "fri", "--hours", "7", "--hours", "18", "--output=human"),
    run(cliPath, "list", "-o", "human"),
    run(cliPath, "call", "nope", "-o", "human"),
  ]);
  assert.deepEqual([status.code, status.stdout], [0, `${STATUS_OFF}\n`]);
  assert.deepEqual([schedule.code, schedule.stdout], [0, `${SCHEDULE_LAYOUT}\n`]);
  assert.equal(list.code, 0);
  assert.ok(list.stdout.startsWith("Capabilities\n  aircon status get "));
  assert.ok(list.stdout.includes("\nEvents\n  watch aircon.status.changed"));
  assert.equal(unknown.code, 2);
  assert.ok(unknown.stderr.startsWith("error (unknown-capability): "));

  const onTerminal = (...args: string[]) => Effect.runPromise(inProcess(args, true).pipe(Effect.provide(freshUnit)));
  assert.deepEqual(await onTerminal("status"), { code: 0, stdout: STATUS_OFF, stderr: "" });
  const json = await onTerminal("status", "--json");
  assert.deepEqual([json.code, JSON.parse(json.stdout)], [0, OFF]);
  assert.deepEqual(await onTerminal("--json"), json, "the default alias with an output flag");
  const unreachable = await Effect.runPromise(inProcess(["aircon", "status", "get"], true).pipe(Effect.provide(Layer.provideMerge(offline, freshUnit))));
  assert.deepEqual(unreachable, { code: 1, stdout: OFFLINE, stderr: "" });
});

test("the command line writes the command list of a shared prefix", async () => {
  await assertHelp((...args) => run(cliPath, ...args));
});
