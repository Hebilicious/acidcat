/** Conformance checks for the CLI binding (spec/bindings/cli.md). Each check runs the command line as a process. */
import { spawn } from "node:child_process";

import { Checks, expect, expectEqual, idsOf, sorted } from "./check.ts";

const RULE = "spec/bindings/cli.md";

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(command: readonly string[], args: readonly string[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0]!, [...command.slice(1), ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export async function checkCli(command: readonly string[]): Promise<Checks> {
  const checks = new Checks("cli");
  const cli = (...args: string[]) => run(command, args);

  await checks.run("a value goes to standard output with exit code 0", `${RULE}#outcomes`, async () => {
    const result = await cli("fixture", "echo", "--text", "hello");
    expectEqual(result.code, 0, "exit code");
    expectEqual(JSON.parse(result.stdout), { text: "hello" }, "standard output");
  });
  await checks.run("a failure goes to standard output with exit code 1", `${RULE}#outcomes`, async () => {
    const result = await cli("fixture", "refuse");
    expectEqual(result.code, 1, "exit code");
    expectEqual((JSON.parse(result.stdout) as { _tag?: string })._tag, "Refused", "_tag");
  });
  await checks.run("a defect goes to standard error with exit code 5", `${RULE}#outcomes`, async () => {
    const result = await cli("fixture", "crash");
    expectEqual(result.code, 5, "exit code");
    expect(/"kind":"internal"/.test(result.stderr), "standard error must contain the call failure");
  });
  for (const [name, args, code] of [
    ["an unknown command has exit code 2", ["fixture", "nothing"], 2],
    ["a capability outside the view has exit code 2", ["call", "fixture.hidden"], 2],
    ["a missing required flag has exit code 3", ["fixture", "echo"], 3],
    ["a flag that is not valid has exit code 3", ["fixture", "slow", "--milliseconds", "soon"], 3],
    ["invalid input through call has exit code 3", ["call", "fixture.echo", '{"text":1}'], 3],
  ] as const) {
    await checks.run(name, `${RULE}#outcomes`, async () => {
      expectEqual((await cli(...args)).code, code, "exit code");
    });
  }
  await checks.run("call gives the value of a capability", `${RULE}#commands`, async () => {
    const result = await cli("call", "fixture.echo", '{"text":"hello"}');
    expectEqual(result.code, 0, "exit code");
    expectEqual(JSON.parse(result.stdout), { text: "hello" }, "standard output");
  });
  await checks.run("list gives the view", `${RULE}#commands`, async () => {
    const result = await cli("list");
    expectEqual(sorted((JSON.parse(result.stdout) as { id: string }[]).map((entry) => entry.id)), idsOf("cli"), "ids");
  });

  return checks;
}
