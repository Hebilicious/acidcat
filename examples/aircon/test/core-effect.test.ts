import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { check } from "@acid-cat/cli";
import { Effect, Fiber, Layer, Schema, Stream } from "effect";

import { aircon, statusChanged, unitLayer } from "../core-effect/aircon.ts";
import { App, Mcp, Session } from "@acid-cat/core-effect";
import { run } from "./run.ts";
import { assertHelp } from "./help.ts";
import type { Run } from "./run.ts";
import { shape, writtenText } from "./shape.ts";
import { OFFLINE, OUTPUT_ERROR, OUTPUT_FLAG_LINES, POWERED_OFF_LAYOUT, SCHEDULE_LAYOUT, STATUS_OFF } from "./human.ts";

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

const cliPath = new URL("../core-effect/cli.ts", import.meta.url).pathname;

async function startServer(context: TestContext): Promise<string> {
  const server = spawn(process.execPath, [new URL("../core-effect/serve.ts", import.meta.url).pathname], { stdio: ["ignore", "pipe", "inherit"] });
  context.after(() => server.kill());
  return await new Promise<string>((resolve, reject) => {
    server.on("error", reject);
    let text = "";
    server.stdout.setEncoding("utf-8").on("data", (chunk: string) => {
      text += chunk;
      if (text.includes("\n")) resolve(text.slice(0, text.indexOf("\n")).trim());
    });
  });
}

test("the aliases of the Effect command line call their capabilities with their fixed input", async (context) => {
  const url = await startServer(context);
  const remote = (...args: string[]) =>
    finish(spawn(process.execPath, [cliPath, ...args], { env: { ...process.env, AIRCON_URL: url }, stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 }));
  assert.equal((await remote("--on")).code, 0);
  const on = await remote("status");
  assert.equal(on.code, 0);
  assert.partialDeepStrictEqual(JSON.parse(on.stdout), { power: true });
  assert.partialDeepStrictEqual(JSON.parse((await remote("--", "status")).stdout), { power: true }, "a first -- is not an argument");
  assert.equal((await remote("--off")).code, 0);
  assert.partialDeepStrictEqual(JSON.parse((await remote("status")).stdout), { power: false });
  assert.equal((await remote("--on", "--on", "false")).code, 3);
  const none = await remote();
  assert.equal(none.code, 0, "the default alias is status");
  assert.partialDeepStrictEqual(JSON.parse(none.stdout), { power: false });
  assert.equal((await remote("fan", "high")).code, 0);
  assert.partialDeepStrictEqual(JSON.parse((await remote("status")).stdout), { fan: "high" });
  assert.equal((await remote("fan", "--speed", "low")).code, 0);
  assert.partialDeepStrictEqual(JSON.parse((await remote("status")).stdout), { fan: "low" });
  const unknown = await remote("fan", "medium");
  assert.deepEqual([unknown.code, unknown.stdout], [2, ""], "medium is not the second word of an alias of the group fan");
});

test("the alias follow of the Effect command line writes each change of the status", async (context) => {
  const url = await startServer(context);
  const remote = (...args: string[]) =>
    spawn(process.execPath, [cliPath, ...args], { env: { ...process.env, AIRCON_URL: url }, stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
  const follow = remote("follow");
  context.after(() => follow.kill());
  let followed = "";
  follow.stdout.setEncoding("utf-8").on("data", (chunk: string) => (followed += chunk));
  // A change before the subscription starts is not in it, so change the power until the first occurrence comes.
  for (let turn = 0; !followed.includes("\n"); turn++) {
    assert.ok(turn < 100, "follow writes an occurrence");
    assert.equal((await finish(remote(turn % 2 === 0 ? "--on" : "--off"))).code, 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const line = followed.slice(0, followed.indexOf("\n"));
  assert.partialDeepStrictEqual(JSON.parse(line), { name: "aircon.status.changed" });
  const exited = new Promise<number | null>((resolve) => follow.on("close", resolve));
  follow.kill("SIGINT");
  assert.equal(await exited, 130);
});

test("the Effect command line controls the unit of a server, and watch follows its changes", async (context) => {
  const url = await startServer(context);
  const remote = (...args: string[]) =>
    spawn(process.execPath, [cliPath, ...args], { env: { ...process.env, AIRCON_URL: url }, stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });

  assert.equal((await finish(remote("aircon", "power", "set", "--on"))).code, 0);
  const status = await finish(remote("aircon", "status", "get"));
  assert.equal(status.code, 0);
  assert.partialDeepStrictEqual(JSON.parse(status.stdout), { power: true });
  assert.partialDeepStrictEqual(JSON.parse((await run(cliPath, "aircon", "status", "get")).stdout), { power: false });

  const watch = remote("watch", "aircon.status.changed");
  context.after(() => watch.kill());
  let watched = "";
  watch.stdout.setEncoding("utf-8").on("data", (chunk: string) => (watched += chunk));
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

test("aircon.status.export writes a file through the command line", async (context) => {
  const folder = await mkdtemp(join(tmpdir(), "aircon-"));
  context.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, "status.json");
  assert.equal((await run(new URL("../core-effect/cli.ts", import.meta.url).pathname, "aircon", "status", "export", "--path", file)).code, 0);
  assert.partialDeepStrictEqual(JSON.parse(await readFile(file, "utf-8")), { power: false });
});

test("the Effect command line writes the human form with its output flags", async () => {
  const cli = (...args: string[]) => run(cliPath, ...args);
  const [status, short, inline, defaultAlias, poweredOff, schedule, list, unknown, json, plain, xml] = await Promise.all([
    cli("status", "--output", "human"),
    cli("-o", "human", "status"),
    cli("--output=human", "status"),
    cli("-o", "human"),
    cli("aircon", "mode", "set", "--output", "human", "--mode", "heat"),
    cli("aircon", "schedule", "set", "--days", "mon", "--days", "fri", "--hours", "7", "--hours", "18", "--output=human"),
    cli("list", "-o", "human"),
    cli("call", "nope", "--output", "human"),
    cli("--output", "json", "aircon", "status", "get"),
    cli("aircon", "status", "get"),
    cli("status", "--output", "xml"),
  ]);
  for (const human of [status, short, inline, defaultAlias]) assert.deepEqual([human.code, human.stdout], [0, `${STATUS_OFF}\n`]);
  assert.ok((await cli("--help")).stdout.endsWith(`\n\nOUTPUT FLAGS\n${OUTPUT_FLAG_LINES}\n`));
  assert.deepEqual([poweredOff.code, poweredOff.stdout], [1, `${POWERED_OFF_LAYOUT}\n`]);
  assert.deepEqual([schedule.code, schedule.stdout], [0, `${SCHEDULE_LAYOUT}\n`]);
  assert.ok(list.stdout.startsWith("Capabilities\n  aircon status get "));
  assert.ok(list.stdout.includes("\nEvents\n  watch aircon.status.changed"));
  assert.equal(unknown.code, 2);
  assert.ok(unknown.stderr.startsWith("error (unknown-capability): "));
  assert.deepEqual([json.code, json.stdout], [plain.code, plain.stdout]);
  assert.deepEqual([xml.code, xml.stdout, xml.stderr], [3, "", `${OUTPUT_ERROR}\n`]);

  const [terminal, terminalJson, terminalDefault, offline] = await Promise.all([
    terminalCli(true, "status"),
    terminalCli(true, "status", "--json"),
    terminalCli(true, "--json"),
    terminalCli(false, "aircon", "status", "get"),
  ]);
  assert.deepEqual([terminal.code, terminal.stdout], [0, `${STATUS_OFF}\n`]);
  assert.deepEqual([terminalJson.code, terminalJson.stdout], [0, plain.stdout]);
  assert.deepEqual([terminalDefault.code, terminalDefault.stdout], [0, plain.stdout], "the default alias with an output flag");
  assert.deepEqual([offline.code, offline.stdout, offline.stderr], [1, `${OFFLINE}\n`, ""]);
});

const terminalScript = (online: boolean) => `
import { NodeCli } from "@acid-cat/core-effect/node";
import { unavailable } from "@acid-cat/spec-ts";
import { Effect, Layer, SubscriptionRef } from "effect";
import { aircon, Unit, unitLayer } from ${JSON.stringify(new URL("../core-effect/aircon.ts", import.meta.url).href)};
import { output } from ${JSON.stringify(new URL("../core-effect/output.ts", import.meta.url).href)};
process.stdout.isTTY = true;
const offline = Layer.effectDiscard(Effect.flatMap(Effect.service(Unit), (unit) => SubscriptionRef.set(unit.connection, unavailable("The unit is offline."))));
NodeCli.main(aircon, ${online ? "unitLayer" : "Layer.provideMerge(offline, unitLayer)"}, { name: "aircon", version: "0.1.0", output }, process.argv.slice(1));
`;

const terminalCli = (online: boolean, ...args: string[]) =>
  finish(
    spawn(process.execPath, ["--input-type=module", "--eval", terminalScript(online), "--", ...args], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { PATH: process.env.PATH ?? "", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    }),
  );

test("the human form of the Effect command line is the same for a server, and watch writes each status", async (context) => {
  const url = await startServer(context);
  const remote = (...args: string[]) =>
    spawn(process.execPath, [cliPath, "--output", "human", ...args], { env: { ...process.env, AIRCON_URL: url }, stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
  const status = await finish(remote("aircon", "status", "get"));
  assert.deepEqual([status.code, status.stdout], [0, `${STATUS_OFF}\n`]);

  const watch = remote("watch", "aircon.status.changed");
  context.after(() => watch.kill());
  let watched = "";
  watch.stdout.setEncoding("utf-8").on("data", (chunk: string) => (watched += chunk));
  for (let turn = 0; !watched.includes("\n"); turn++) {
    assert.ok(turn < 100, "watch writes an occurrence");
    assert.equal((await finish(remote("aircon", "fan", "set", "--speed", turn % 2 === 0 ? "low" : "high"))).code, 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const line = watched.slice(0, watched.indexOf("\n"));
  assert.ok([STATUS_OFF.replace("fan auto", "fan low"), STATUS_OFF.replace("fan auto", "fan high")].includes(line), line);
});

test("the Effect command line writes the help of a command and the command list of a shared prefix", async () => {
  await assertHelp((...args) => run(cliPath, ...args));
});
