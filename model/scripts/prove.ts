import { spawn } from "node:child_process";
import { totalmem } from "node:os";
import { join } from "node:path";

const MODEL = join(import.meta.dirname, "..");

const PROPERTIES = [
  { main: "cliOutputArguments", invariant: "notTerminalGivesJson" },
  { main: "cliOutputNames", invariant: "acceptedNamesAreSafe" },
  { main: "cliOutputArguments", invariant: "argumentsAfterTheStopStay" },
  { main: "cliOutputArguments", invariant: "lastOutputFlagWins" },
  { main: "cliOutputArguments", invariant: "badValueStops" },
] as const;

// Each Apalache server uses up to about 7 GB: a Java heap of 4 GB, and the memory of the Z3 solver.
const SERVERS = Math.max(1, Math.min(PROPERTIES.length, Math.floor(totalmem() / 7e9)));
const FIRST_PORT = 8822;

type Property = (typeof PROPERTIES)[number];

function prove({ main, invariant }: Property, port: number): Promise<string> {
  const args = ["verify", "cli-output-properties.qnt", `--main=${main}`, `--invariant=${invariant}`, "--max-steps=0", `--server-endpoint=localhost:${port}`];
  return new Promise((resolve) => {
    const child = spawn(join(MODEL, "node_modules", ".bin", "quint"), args, { cwd: MODEL, stdio: ["ignore", "pipe", "pipe"] });
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
    child.on("close", (code) => {
      const text = Buffer.concat(output).toString("utf8");
      const verdict = code === 0 ? (text.split("\n").find((line) => line.includes("violation")) ?? text) : text;
      const line = `quint ${args.slice(0, -1).join(" ")}\n  ${verdict.trim()}`;
      if (code !== 0) process.exitCode = 1;
      resolve(line);
    });
  });
}

const queue = [...PROPERTIES];
await Promise.all(
  Array.from({ length: SERVERS }, async (_, server) => {
    for (let property = queue.shift(); property !== undefined; property = queue.shift()) console.log(await prove(property, FIRST_PORT + server));
  }),
);
