import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const directory = new URL("../catalog/", import.meta.url).pathname;
const expected = readFileSync(new URL("../catalog/aircon.acidcat.json", import.meta.url), "utf-8");

/** Runs a program of the catalog directory, and gives what it writes. */
const output = (command: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) =>
  execFileSync(command, args, { cwd: options.cwd ?? directory, env: options.env ?? process.env, encoding: "utf-8" });

test("the TypeScript catalog library writes the same catalog as Pkl", () => {
  assert.equal(output("node", ["typescript.ts"]), expected);
});

test("the Python catalog library writes the same catalog as Pkl", () => {
  const library = new URL("../../../packages/catalog/python", import.meta.url).pathname;
  assert.equal(output("python", ["python.py"], { env: { ...process.env, PYTHONPATH: library, PYTHONDONTWRITEBYTECODE: "1" } }), expected);
});

test("the Go catalog library writes the same catalog as Pkl", () => {
  assert.equal(output("go", ["run", "."], { cwd: `${directory}go` }), expected);
});

test("the Rust catalog library writes the same catalog as Pkl", () => {
  assert.equal(output("cargo", ["run", "--quiet"], { cwd: `${directory}rust` }), expected);
});
