/** Conformance checks for the CLI binding (spec/bindings/cli.md). Each check runs the command line as a process. */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Checks, expect, expectEqual, GUARD, idsOf, sorted } from "./check.ts";

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
  /** True if the guard ended the process with `SIGKILL`. */
  readonly guarded: boolean;
}

/**
 * Run the command line. If it runs for longer than `guard` milliseconds, end it with `SIGKILL`: the guard is a limit of
 * the infrastructure, so that a command line that never exits fails its check and the run ends. `whileRunning` gets
 * the process while it runs, for example to interrupt it, and a function that starts the guard again.
 */
function run(
  command: readonly string[],
  args: readonly string[],
  guard: number,
  whileRunning?: (child: ChildProcess, restartGuard: () => void) => void,
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0]!, [...command.slice(1), ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let guarded = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startGuard = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        guarded = true;
        child.kill("SIGKILL");
      }, guard);
    };
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, guarded });
    });
    startGuard();
    whileRunning?.(child, startGuard);
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

export async function checkCli(command: readonly string[], guard = GUARD): Promise<Checks> {
  const checks = new Checks("cli");
  const cli = async (...args: string[]) => {
    const result = await run(command, args, guard);
    expect(!result.guarded, `the command line with ${args.join(" ")} did not exit within ${guard} ms, the guard of acid-cat conform`);
    return result;
  };

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
    ["a flag that is not valid has exit code 3", ["fixture", "flags", "--mode", "fast", "--count", "soon"], 3],
    ["invalid input through call has exit code 3", ["call", "fixture.echo", '{"text":1}'], 3],
  ] as const) {
    await checks.run(name, `${RULE}#outcomes`, async () => {
      expectEqual((await cli(...args)).code, code, "exit code");
    });
  }
  await checks.run("an interrupt cancels the call with exit code 130", `${RULE}#commands`, async () => {
    // The call holds until it is released. It creates the marker file when it holds, and the interrupt comes then.
    const directory = await mkdtemp(join(tmpdir(), "acid-cat-conform-"));
    const marker = join(directory, "held");
    try {
      let interrupted = false;
      const result = await run(command, ["fixture", "hold", "--key", "interrupt", "--marker", marker], guard, (child, restartGuard) =>
        whenCreated(marker, child, () => {
          interrupted = true;
          restartGuard();
          child.kill("SIGINT");
        }),
      );
      expect(
        interrupted,
        result.guarded
          ? `the call did not hold within ${guard} ms, the guard of acid-cat conform`
          : `the call must hold before the interrupt; it ended with ${result.code}: ${result.stderr}`,
      );
      expect(!result.guarded, `the command line did not exit after the interrupt within ${guard} ms, the guard of acid-cat conform`);
      expect(result.signal === null, `the process must exit, not end by the signal ${result.signal}`);
      expectEqual(result.code, 130, "exit code");
      expectEqual(result.stdout, "", "standard output");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  await checks.run("call gives the value of a capability", `${RULE}#commands`, async () => {
    const result = await cli("call", "fixture.echo", '{"text":"hello"}');
    expectEqual(result.code, 0, "exit code");
    expectEqual(JSON.parse(result.stdout), { text: "hello" }, "standard output");
  });
  await checks.run("list gives the view", `${RULE}#commands`, async () => {
    const result = await cli("list");
    expectEqual(sorted((JSON.parse(result.stdout) as { id: string }[]).map((entry) => entry.id)), idsOf("cli"), "ids");
  });
  await checks.run("list gives the usage of each capability, with its flags", `${RULE}#commands`, async () => {
    const entries = JSON.parse((await cli("list")).stdout) as { id: string; usage?: unknown }[];
    for (const { id, usage } of entries) {
      expect(typeof usage === "string", `${id} must have a usage`);
      const [program, ...rest] = usage.split(" ");
      expect(program !== "" && rest.length > 0, `the usage of ${id} must start with the name of the program, got ${JSON.stringify(usage)}`);
      expectEqual(rest.join(" "), USAGES[id], `usage of ${id} after the name of the program`);
    }
  });

  return checks;
}
