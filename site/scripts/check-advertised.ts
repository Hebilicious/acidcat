import { parseArgs } from "node:util";
import { checkAdvertised } from "./advertised.ts";

const { positionals } = parseArgs({ allowPositionals: true });
const [given] = positionals;
if (given === undefined) throw new Error("Give the origin to check, for example https://site-agent-ready-acidcat.hebilicious.workers.dev.");
const origin = new URL(given).origin;

const results = await checkAdvertised(origin, (input, init) => fetch(input, init));
for (const result of results) console.log(`${result.problem === undefined ? "ok  " : "FAIL"} ${result.status} ${result.path} (${result.contentType || "no type"}; listed by ${result.listedBy})${result.problem === undefined ? "" : `: ${result.problem}`}`);
const failed = results.filter((result) => result.problem !== undefined);
console.log(`${results.length - failed.length} of ${results.length} URLs answer on ${origin}.`);
if (failed.length > 0) process.exitCode = 1;
