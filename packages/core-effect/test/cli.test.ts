import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const program = (file: string) => (...args: string[]) => {
  const run = spawnSync(process.execPath, [new URL(file, import.meta.url).pathname, ...args], { encoding: "utf-8" });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
};

const cli = program("./fixture-cli.ts");
/** The command line with the flag `--switch` of the application. The services of the capabilities depend on it. */
const cliWithFlag = program("./fixture-cli-flags.ts");

const toggle = (stdout: string) =>
  (JSON.parse(stdout) as { id: string; available: boolean }[]).find((entry) => entry.id === "fixture.toggle");

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

test("a flag of the application decides the services of the capabilities", () => {
  assert.equal(toggle(cliWithFlag("list").stdout)?.available, true);
  assert.equal(toggle(cliWithFlag("--switch", "false", "list").stdout)?.available, false);
});

test("a command that the application changed keeps the exit codes", () => {
  assert.equal(cliWithFlag("--switch", "false", "fixture", "echo", "--text", "hi").code, 0);
  assert.equal(cliWithFlag("--switch", "false", "nope").code, 2);
  assert.equal(cliWithFlag("--switch", "false", "fixture", "echo").code, 3);
});

const cliWithCommand = program("./fixture-cli-app.ts");

test("a command of the application runs beside the commands of the capabilities, and writes outcomes in the same way", () => {
  const greeted = cliWithCommand("greet", "Ada");
  assert.equal(greeted.code, 0);
  assert.equal(JSON.parse(greeted.stdout), "Hello, Ada.");
  const refused = cliWithCommand("greet", "nobody");
  assert.equal(refused.code, 1);
  assert.deepEqual(JSON.parse(refused.stdout), { _tag: "NoOne" });
  assert.equal(cliWithCommand("fixture", "echo", "--text", "hi").code, 0);
  assert.equal(toggle(cliWithCommand("--switch", "false", "list").stdout)?.available, false);
  assert.equal(cliWithCommand("nope").code, 2);
});

test("an interrupt before the program first waits cancels the call with exit code 130", () => {
  const run = program("./fixture-cli-interrupt.ts")("probe", "interrupt");
  assert.equal(run.code, 130);
  assert.equal(run.stdout, "");
});
