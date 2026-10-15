/** Conformance checks for the CLI binding (spec/bindings/cli.md). Each check runs the command line as a process. */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Checks, expect, expectEqual, GUARD, idsOf, sorted } from "./check.ts";
import type { Deadline, Guard } from "./check.ts";

const RULE = "spec/bindings/cli.md";

/** The `usage` of each capability in the view of the fixture, after the name of the program. */
const USAGES: { readonly [id: string]: string } = {
  "fixture.crash": "fixture crash",
  "fixture.echo": "fixture echo --text <string>",
  "fixture.flags": "fixture flags --mode <fast|slow> [--count <integer>] [--extra <json>] [--label <string>] [--ratio <number>] [--verbose]",
  "fixture.refuse": "fixture refuse",
  "fixture.held": "fixture held",
  "fixture.hold": "fixture hold --key <string> [--marker <string>]",
  "fixture.release": "fixture release --key <string>",
  "fixture.switch.set": "fixture switch set --on",
  "fixture.toggle": "fixture toggle",
};

interface Run {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True if the deadline of the check ended the process with `SIGKILL`. */
  readonly guarded: boolean;
}

/**
 * Run the command line in a check. When the deadline of the check aborts its signal, end the process with `SIGKILL`, so
 * that no process outlives its check: the deadline is a limit of the infrastructure, and a command line that does not
 * exit fails its check. `whileRunning` gets the process while it runs, for example to interrupt it.
 */
function run(command: readonly string[], args: readonly string[], deadline: Deadline, whileRunning?: (child: ChildProcess) => void): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0]!, [...command.slice(1), ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let guarded = false;
    const stop = () => {
      guarded = true;
      child.kill("SIGKILL");
    };
    if (deadline.signal.aborted) stop();
    else deadline.signal.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      deadline.signal.removeEventListener("abort", stop);
      reject(error);
    });
    child.on("close", (code, signal) => {
      deadline.signal.removeEventListener("abort", stop);
      resolve({ code, signal, stdout, stderr, guarded });
    });
    whileRunning?.(child);
  });
}

/** Call `then` when the file at `path` exists. Stop watching when the process exits. */
function whenCreated(path: string, child: ChildProcess, then: () => void): void {
  const watcher = watch(join(path, ".."), () => check());
  const check = () => {
    if (!existsSync(path)) return;
    watcher.close();
    then();
  };
  child.on("close", () => watcher.close());
  check();
}

export async function checkCli(command: readonly string[], guard: Guard = GUARD): Promise<Checks> {
  const checks = new Checks("cli", guard);
  const cli = async (deadline: Deadline, ...args: string[]) => {
    const result = await run(command, args, deadline);
    expect(!result.guarded, `the command line with ${args.join(" ")} did not exit within ${deadline.guard} ms, the guard of acid-cat conform`);
    return result;
  };

  await checks.run("a value goes to standard output with exit code 0", `${RULE}#outcomes`, async (deadline) => {
    const result = await cli(deadline, "fixture", "echo", "--text", "hello");
    expectEqual(result.code, 0, "exit code");
    expectEqual(JSON.parse(result.stdout), { text: "hello" }, "standard output");
  });
  await checks.run("a failure goes to standard output with exit code 1", `${RULE}#outcomes`, async (deadline) => {
    const result = await cli(deadline, "fixture", "refuse");
    expectEqual(result.code, 1, "exit code");
    expectEqual((JSON.parse(result.stdout) as { _tag?: string })._tag, "Refused", "_tag");
  });
  await checks.run("a defect goes to standard error with exit code 5", `${RULE}#outcomes`, async (deadline) => {
    const result = await cli(deadline, "fixture", "crash");
    expectEqual(result.code, 5, "exit code");
    expect(/"kind":"internal"/.test(result.stderr), "standard error must contain the call failure");
  });
  for (const [name, args, code] of [
    ["an unknown command has exit code 2", ["fixture", "nothing"], 2],
    ["a capability outside the view has exit code 2", ["call", "fixture.hidden"], 2],
    ["a missing required flag has exit code 3", ["fixture", "echo"], 3],
    ["a flag that is not valid has exit code 3", ["fixture", "flags", "--mode", "fast", "--count", "soon"], 3],
    ["invalid input through call has exit code 3", ["call", "fixture.echo", '{"text":1}'], 3],
  ] as const) {
    await checks.run(name, `${RULE}#outcomes`, async (deadline) => {
      expectEqual((await cli(deadline, ...args)).code, code, "exit code");
    });
  }
  await checks.run("an interrupt cancels the call with exit code 130", `${RULE}#commands`, async (deadline) => {
    // The call holds until it is released. It creates the marker file when it holds, and the interrupt comes then.
    const directory = await mkdtemp(join(tmpdir(), "acid-cat-conform-"));
    const marker = join(directory, "held");
    try {
      let interrupted = false;
      const result = await run(command, ["fixture", "hold", "--key", "interrupt", "--marker", marker], deadline, (child) =>
        whenCreated(marker, child, () => {
          interrupted = true;
          child.kill("SIGINT");
        }),
      );
      expect(
        interrupted,
        result.guarded
          ? `the call did not hold within ${deadline.guard} ms, the guard of acid-cat conform`
          : `the call must hold before the interrupt; it ended with ${result.code}: ${result.stderr}`,
      );
      expect(!result.guarded, `the command line did not exit after the interrupt within ${deadline.guard} ms, the guard of acid-cat conform`);
      expect(result.signal === null, `the process must exit, not end by the signal ${result.signal}`);
      expectEqual(result.code, 130, "exit code");
      expectEqual(result.stdout, "", "standard output");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  await checks.run("call gives the value of a capability", `${RULE}#commands`, async (deadline) => {
    const result = await cli(deadline, "call", "fixture.echo", '{"text":"hello"}');
    expectEqual(result.code, 0, "exit code");
    expectEqual(JSON.parse(result.stdout), { text: "hello" }, "standard output");
  });
  await checks.run("list gives the view", `${RULE}#commands`, async (deadline) => {
    const result = await cli(deadline, "list");
    expectEqual(sorted((JSON.parse(result.stdout) as { id: string }[]).map((entry) => entry.id)), idsOf("cli"), "ids");
  });
  await checks.run("list gives the usage of each capability, with its flags", `${RULE}#commands`, async (deadline) => {
    const entries = JSON.parse((await cli(deadline, "list")).stdout) as { id: string; usage?: unknown }[];
    for (const { id, usage } of entries) {
      expect(typeof usage === "string", `${id} must have a usage`);
      const [program, ...rest] = usage.split(" ");
      expect(program !== "" && rest.length > 0, `the usage of ${id} must start with the name of the program, got ${JSON.stringify(usage)}`);
      expectEqual(rest.join(" "), USAGES[id], `usage of ${id} after the name of the program`);
    }
  });

  return checks;
}
