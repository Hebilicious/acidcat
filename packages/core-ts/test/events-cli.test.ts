import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { isJsonObject, isOccurrence } from "@acid-cat/spec-ts";

import { defineApp, defineCapability, ok, runCli } from "../src/index.ts";
import { sensorOptions, Sensors, sensorsApp, toJsonSchema } from "./sensors.ts";

/** Wait until a condition is true, or fail after one second. */
async function until(condition: () => boolean): Promise<void> {
  const end = Date.now() + 1000;
  while (!condition()) {
    if (Date.now() > end) throw new Error("The condition did not become true.");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** The member `key` of a JSON text that is an object. */
function memberOf(text: string, key: string): unknown {
  const value: unknown = JSON.parse(text);
  return isJsonObject(value) ? value[key] : undefined;
}

/** Run the command line of the sensors in this process, and keep what it writes. */
function commandLine(args: readonly string[], sensors = new Sensors(), signal?: AbortSignal) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runCli(sensorsApp, { name: "sensors", version: "0.0.0", ...sensorOptions(sensors) }, args, {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    signal,
  });
  return { code, out, err };
}

test("list gives the capabilities, then the events, each with its kind and its usage", async () => {
  const { code, out } = commandLine(["list"]);
  assert.equal(await code, 0);
  const items: unknown = JSON.parse(out.join("\n"));
  assert.deepEqual(items, [
    { kind: "capability", id: "sensor.read", description: "The last reading.", available: true, usage: "sensors sensor read" },
    { kind: "event", id: "sensor.reading.changed", description: "A sensor gave a new reading. The occurrence gives the room and the temperature.", usage: "sensors watch sensor.reading.changed [--room <string>]" },
    { kind: "event", id: "sensor.ticks", description: "Three ticks, then the subscription is complete.", usage: "sensors watch sensor.ticks" },
    { kind: "event", id: "sensor.clock", description: "A tick every 10 milliseconds.", usage: "sensors watch sensor.clock" },
    { kind: "event", id: "sensor.broken", description: "One good reading, then a reading that is too hot.", usage: "sensors watch sensor.broken" },
    { kind: "event", id: "sensor.failing", description: "One reading, then the sensor fails.", usage: "sensors watch sensor.failing" },
    { kind: "event", id: "sensor.threshold", description: "The readings above a temperature.", usage: "sensors watch sensor.threshold '<json>'" },
  ]);
});

test("watch writes each occurrence on one line, and a complete subscription exits with 0", async () => {
  const { code, out, err } = commandLine(["watch", "sensor.ticks"]);
  assert.equal(await code, 0);
  assert.equal(out.length, 3);
  for (const line of out) {
    assert.ok(!line.includes("\n"));
    assert.ok(isOccurrence(JSON.parse(line)));
  }
  assert.deepEqual(err, []);
});

test("watch takes flags from the input schema, or JSON text when the schema has no properties", async () => {
  const sensors = new Sensors();
  const controller = new AbortController();
  const flags = commandLine(["watch", "sensor.reading.changed", "--room", "kitchen"], sensors, controller.signal);
  const json = commandLine(["watch", "sensor.threshold", '{"above":20}'], sensors, controller.signal);
  await until(() => sensors.listeners === 2);
  sensors.emit("hall", 25, "2026-11-10T09:00:00.000Z");
  sensors.emit("kitchen", 19, "2026-11-10T09:00:01.000Z");
  await until(() => flags.out.length === 1 && json.out.length === 1);
  controller.abort();
  assert.equal(await flags.code, 130);
  assert.equal(await json.code, 130);
  assert.deepEqual(JSON.parse(flags.out[0] ?? ""), { eventId: "reading-1", name: "sensor.reading.changed", timestamp: "2026-11-10T09:00:01.000Z", data: { room: "kitchen", celsius: 19 }, cursor: "1" });
  assert.deepEqual(memberOf(json.out[0] ?? "", "data"), { room: "hall", celsius: 25 });
});

test("watch: internal exits with 5 and writes the failure, and start failures have the exit codes of calls", async () => {
  const failing = commandLine(["watch", "sensor.failing"]);
  assert.equal(await failing.code, 5);
  assert.equal(failing.out.length, 1);
  assert.deepEqual(failing.err.map((line): unknown => JSON.parse(line)), [{ kind: "internal", message: "The event failed." }]);

  const unknown = commandLine(["watch", "sensor.hidden"]);
  assert.equal(await unknown.code, 2);
  assert.deepEqual(JSON.parse(unknown.err[0] ?? ""), { kind: "unknown-capability", message: "There is no event sensor.hidden." });
  const invalid = commandLine(["watch", "sensor.threshold", '{"above":"hot"}']);
  assert.equal(await invalid.code, 3);
  assert.equal(memberOf(invalid.err[0] ?? "", "kind"), "invalid-input");
  assert.equal(await commandLine(["watch", "sensor.reading.changed", "--floor", "1"]).code, 3);
  assert.equal(await commandLine(["watch"]).code, 3);
});

test("watch --help gives the usage of the event, and the help lists watch", async () => {
  const usage = commandLine(["watch", "sensor.reading.changed", "--help"]);
  assert.equal(await usage.code, 0);
  assert.match(usage.out.join("\n"), /^Usage: sensors watch sensor\.reading\.changed \[--room <string>\]/);
  const help = commandLine([]);
  assert.equal(await help.code, 0);
  assert.match(help.out.join("\n"), /watch <id>/);
});

test("watch is a command of the command line: no capability and no command of the application can have its name", async () => {
  const app = defineApp({
    targets: { cli: { bindings: ["cli"] } },
    capabilities: [defineCapability({ id: "watch.start", description: "A capability whose command starts with watch.", audience: ["cli"], run: () => ok(null) })],
  });
  await assert.rejects(runCli(app, { name: "probe", version: "0", toJsonSchema, context: undefined }, ["list"], { stdout: () => {}, stderr: () => {} }), /watch start/);
  const command = { name: "watch", description: "Mine.", run: () => 0 };
  await assert.rejects(runCli(sensorsApp, { name: "sensors", version: "0", ...sensorOptions(), commands: [command] }, ["list"], { stdout: () => {}, stderr: () => {} }), /watch/);
});

test("in a process, an interrupt ends watch with the exit code 130", async () => {
  const fixture = fileURLToPath(new URL("./fixture-sensors-cli.ts", import.meta.url));
  const child = spawn(process.execPath, [fixture, "watch", "sensor.clock"], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const end = Date.now() + 10_000;
  while (!out.includes("\n")) {
    if (Date.now() > end) throw new Error(`The command line wrote no occurrence. ${err}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  child.kill("SIGINT");
  assert.equal(await exited, 130);
  assert.equal(err, "");
  for (const line of out.trim().split("\n")) assert.ok(isOccurrence(JSON.parse(line)));
});
