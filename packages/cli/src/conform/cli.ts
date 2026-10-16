/** Conformance checks for the CLI binding (spec/bindings/cli.md). Each check runs the command line as a process. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Checks, expect, expectEqual, idsOf, sorted, until } from "./check.ts";

const RULE = "spec/bindings/cli.md";

/** The `usage` of each capability in the view of the fixture, after the name of the program. */
const USAGES: { readonly [id: string]: string } = {
  "fixture.crash": "fixture crash",
  "fixture.echo": "fixture echo --text <string>",
  "fixture.flags": "fixture flags --mode <fast|slow> [--count <integer>] [--extra <json>] [--label <string>] [--ratio <number>] [--verbose]",
  "fixture.held": "fixture held",
  "fixture.hold": "fixture hold --key <string> [--marker <string>]",
  "fixture.refuse": "fixture refuse",
  "fixture.release": "fixture release --key <string>",
  "fixture.switch.set": "fixture switch set --on",
  "fixture.toggle": "fixture toggle",
};

interface Run {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Start the command line. When the signal aborts, the process is killed, and its run rejects. */
function start(command: readonly string[], args: readonly string[], signal: AbortSignal) {
  const child = spawn(command[0]!, [...command.slice(1), ...args], { stdio: ["ignore", "pipe", "pipe"], signal, killSignal: "SIGKILL" });
  const run = new Promise<Run>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => reject(signal.aborted ? new Error(`waiting until the command line exits: ${args.join(" ")}`) : error));
    child.on("close", (code, exitSignal) => resolve({ code, signal: exitSignal, stdout, stderr }));
  });
  return { child, run };
}

export async function checkCli(command: readonly string[], options: { readonly deadline: number }): Promise<Checks> {
  const checks = new Checks("cli", options.deadline);
  const run = (signal: AbortSignal, ...args: string[]) => start(command, args, signal).run;

  await checks.run("a value goes to standard output with exit code 0", `${RULE}#outcomes`, async (signal) => {
    const result = await run(signal, "fixture", "echo", "--text", "hello");
    expectEqual(result.code, 0, "exit code");
    expectEqual(JSON.parse(result.stdout), { text: "hello" }, "standard output");
  });
  await checks.run("a failure goes to standard output with exit code 1", `${RULE}#outcomes`, async (signal) => {
    const result = await run(signal, "fixture", "refuse");
    expectEqual(result.code, 1, "exit code");
    expectEqual((JSON.parse(result.stdout) as { _tag?: string })._tag, "Refused", "_tag");
  });
  await checks.run("a defect goes to standard error with exit code 5", `${RULE}#outcomes`, async (signal) => {
    const result = await run(signal, "fixture", "crash");
    expectEqual(result.code, 5, "exit code");
    expect(/"kind":"internal"/.test(result.stderr), "standard error must contain the call failure");
  });
  for (const [name, args, code] of [
    ["an unknown command has exit code 2", ["fixture", "nothing"], 2],
    ["a capability outside the view has exit code 2", ["call", "fixture.hidden"], 2],
    ["a missing required flag has exit code 3", ["fixture", "echo"], 3],
    ["a flag that is not valid has exit code 3", ["fixture", "flags", "--mode", "fast", "--ratio", "soon"], 3],
    ["invalid input through call has exit code 3", ["call", "fixture.echo", '{"text":1}'], 3],
  ] as const) {
    await checks.run(name, `${RULE}#outcomes`, async (signal) => {
      expectEqual((await run(signal, ...args)).code, code, "exit code");
    });
  }
  await checks.run("an interrupt cancels the call with exit code 130", `${RULE}#commands`, async (signal) => {
    const directory = await mkdtemp(join(tmpdir(), "acid-cat-conform-"));
    const marker = join(directory, "held");
    try {
      const { child, run } = start(command, ["fixture", "hold", "--key", "interrupt", "--marker", marker], signal);
      const ended = () => child.exitCode !== null || child.signalCode !== null;
      await until("the call writes its marker file", async () => existsSync(marker) || ended(), (ready) => ready, signal);
      if (!ended()) child.kill("SIGINT");
      const result = await run;
      expect(existsSync(marker), `the call must hold before the interrupt, but the command line ended with ${result.code}: ${result.stderr}`);
      expect(result.signal === null, `the process must exit, not end by the signal ${result.signal}`);
      expectEqual(result.code, 130, "exit code");
      expectEqual(result.stdout, "", "standard output");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  await checks.run("call gives the value of a capability", `${RULE}#commands`, async (signal) => {
    const result = await run(signal, "call", "fixture.echo", '{"text":"hello"}');
    expectEqual(result.code, 0, "exit code");
    expectEqual(JSON.parse(result.stdout), { text: "hello" }, "standard output");
  });
  await checks.run("list gives the view", `${RULE}#commands`, async (signal) => {
    const result = await run(signal, "list");
    expectEqual(sorted((JSON.parse(result.stdout) as { id: string }[]).map((entry) => entry.id)), idsOf("cli"), "ids");
  });
  await checks.run("list gives the usage of each capability, with its flags", `${RULE}#commands`, async (signal) => {
    const entries = JSON.parse((await run(signal, "list")).stdout) as { id: string; usage?: unknown }[];
    for (const { id, usage } of entries) {
      expect(typeof usage === "string", `${id} must have a usage`);
      const [program, ...rest] = usage.split(" ");
      expect(program !== "" && rest.length > 0, `the usage of ${id} must start with the name of the program, got ${JSON.stringify(usage)}`);
      expectEqual(rest.join(" "), USAGES[id], `usage of ${id} after the name of the program`);
    }
  });

  return checks;
}
