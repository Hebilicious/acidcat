import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { isRunResult, summarize } from "./results.ts";
import type { RunResult } from "./results.ts";

const { values } = parseArgs({ options: { results: { type: "string", default: "results" }, out: { type: "string" } } });

const files = (await readdir(values.results, { recursive: true })).filter((file) => file.endsWith("results.json")).sort();
const results: RunResult[] = [];
for (const file of files) {
  const value: unknown = JSON.parse(await readFile(join(values.results, file), "utf8"));
  if (!isRunResult(value)) throw new Error(`${file} is not a result of src/run.ts.`);
  results.push(value);
}
if (results.length === 0) throw new Error(`${values.results} has no results.json.`);

const suites = [...new Set(results.map((result) => result.suite))];
const text = suites.map((suite) => summarize(results.filter((result) => result.suite === suite))).join("\n");
if (values.out !== undefined) await writeFile(values.out, text);
const stepSummary = process.env["GITHUB_STEP_SUMMARY"];
if (stepSummary !== undefined) await appendFile(stepSummary, text);
console.log(text);
