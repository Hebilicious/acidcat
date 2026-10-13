import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const cli = (...args: string[]) => {
  const run = spawnSync(process.execPath, [new URL("./fixture-cli.ts", import.meta.url).pathname, ...args], {
    encoding: "utf-8",
    timeout: 20_000,
  });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
};

test("a value goes to standard output with exit code 0", () => {
  const run = cli("fixture", "echo", "--text", "hi");
  assert.equal(run.code, 0);
  assert.deepEqual(JSON.parse(run.stdout), { text: "hi" });
});

test("a failure goes to standard output with exit code 1", () => {
  const run = cli("fixture", "refuse");
  assert.equal(run.code, 1);
  assert.deepEqual(JSON.parse(run.stdout), { _tag: "Refused", reason: "No." });
});

test("each call failure has its exit code", () => {
  assert.equal(cli("call", "fixture.echo", '{"text":1}').code, 3);
  assert.equal(cli("call", "fixture.hidden").code, 2);
  const crash = cli("fixture", "crash");
  assert.equal(crash.code, 5);
  assert.match(crash.stderr, /"kind":"internal"/);
});

test("an unknown command and a missing flag have exit codes", () => {
  assert.equal(cli("nope").code, 2);
  assert.equal(cli("fixture", "echo").code, 3);
});

test("list gives the capabilities of the view", () => {
  const ids = (JSON.parse(cli("list").stdout) as { id: string }[]).map((entry) => entry.id);
  assert.ok(ids.includes("fixture.echo"));
  assert.ok(!ids.includes("fixture.hidden"));
});
