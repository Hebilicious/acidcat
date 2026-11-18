import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { isJsonObject } from "@acid-cat/spec-ts";
import { z } from "zod";

import { defineApp, defineEvent, runCli } from "../src/index.ts";
import { sensorOptions, Sensors, sensorsApp, toJsonSchema } from "./sensors.ts";
import { bundledProgram } from "./bundled-program.ts";
import { until } from "./until.ts";

function memberOf(text: string, key: string): unknown {
  const value: unknown = JSON.parse(text);
  return isJsonObject(value) ? value[key] : undefined;
}

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

test("watch with an unknown flag has exit code 3", async () => {
  assert.equal(await commandLine(["watch", "sensor.reading.changed", "--floor", "1"]).code, 3);
});

test("in a process, a command line that breaks a rule stops when it starts, with the message and the exit code 5", () => {
  const fixture = bundledProgram("test/fixture-sensors-cli-setup-error.ts");
  const { status, stdout, stderr } = spawnSync(process.execPath, [fixture, "list"], { encoding: "utf-8" });
  assert.equal(status, 5);
  assert.equal(stdout, "");
  assert.equal(stderr, "The command watch of the application has the same name as another command.\n");
});

test("watch --cursor and --max-age-ms resume the subscription", async () => {
  const sensors = new Sensors();
  const old = new Date(Date.now() - 60_000).toISOString();
  sensors.emit("kitchen", 18, old);
  sensors.emit("kitchen", 19);
  sensors.emit("hall", 25);
  const controller = new AbortController();
  const flags = commandLine(["watch", "sensor.reading.changed", "--room", "kitchen", "--cursor", "0"], sensors, controller.signal);
  const json = commandLine(["watch", "sensor.reading.changed", "--cursor=-1", "--max-age-ms=1000"], sensors, controller.signal);
  await until(() => flags.out.length === 1 && json.out.length === 2);
  controller.abort();
  assert.equal(await flags.code, 130);
  assert.equal(await json.code, 130);
  assert.equal(memberOf(flags.out[0] ?? "", "cursor"), "1");
  assert.equal(memberOf(json.out[0] ?? "", "cursor"), "1");
  assert.equal(memberOf(json.out[0] ?? "", "truncated"), true);
  assert.equal(memberOf(json.out[1] ?? "", "cursor"), "2");
});

test("watch takes the resume flags after JSON text, and rejects a negative or empty --max-age-ms and a --cursor with no value", async () => {
  const sensors = new Sensors();
  sensors.emit("hall", 25);
  sensors.emit("hall", 26);
  const controller = new AbortController();
  const json = commandLine(["watch", "sensor.threshold", '{"above":20}', "--cursor", "0"], sensors, controller.signal);
  await until(() => sensors.listeners === 1);
  sensors.emit("hall", 27);
  await until(() => json.out.length === 1);
  controller.abort();
  assert.equal(await json.code, 130);
  assert.equal(memberOf(json.out[0] ?? "", "cursor"), "2");

  for (const value of ["-5", ""]) {
    const invalid = commandLine(["watch", "sensor.ticks", "--max-age-ms", value]);
    assert.equal(await invalid.code, 3, value);
  }
  assert.equal(await commandLine(["watch", "sensor.ticks", "--cursor"]).code, 3);
});

test("the command line stops with an error when an input of an event has a property cursor or max-age-ms", async () => {
  for (const name of ["cursor", "max-age-ms"]) {
    const app = defineApp({
      targets: { cli: { bindings: ["cli"] } },
      capabilities: [],
      events: [defineEvent({ id: "probe.changed", description: "A probe event.", audience: ["cli"], input: z.object({ [name]: z.string() }), async *subscribe() {} })],
    });
    await assert.rejects(runCli(app, { name: "probe", version: "0", toJsonSchema, context: undefined }, ["list"], { stdout: () => {}, stderr: () => {} }), new RegExp(`property ${name}`));
  }
});
