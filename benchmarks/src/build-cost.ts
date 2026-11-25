import { appendFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { spread } from "./stats.ts";
import type { Spread } from "./stats.ts";

/** One measure of the cost of a build on one runner: a time in seconds, or a size in megabytes. */
export interface CostSample {
  readonly build: string;
  readonly measure: string;
  readonly value: number;
}

export const isCostSample = (value: unknown): value is CostSample =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "build") === "string" &&
  typeof Reflect.get(value, "measure") === "string" &&
  typeof Reflect.get(value, "value") === "number";

const unique = (values: readonly string[]): string[] => [...new Set(values)];

const cell = (stats: Spread): string =>
  stats.n === 0 ? "–" : `${stats.median.toFixed(2)} (${stats.q1.toFixed(2)}–${stats.q3.toFixed(2)}; ${stats.min.toFixed(2)}–${stats.max.toFixed(2)})`;

/** A Markdown table with a row for each measure: the median of each build, its quartiles and its range, and the ratio of the last build to the first. */
export const costTable = (samples: readonly CostSample[]): string => {
  const builds = unique(samples.map((sample) => sample.build));
  const first = builds[0];
  const last = builds.at(-1);
  const rows = [`| Measure | ${builds.join(" | ")} | ${last} ÷ ${first} |`, `| --- | ${builds.map(() => "---").join(" | ")} | --- |`];
  for (const measure of unique(samples.map((sample) => sample.measure))) {
    const stats = builds.map((build) => spread(samples.filter((sample) => sample.build === build && sample.measure === measure).map((sample) => sample.value)));
    const ratio = (stats.at(-1)?.median ?? Number.NaN) / (stats[0]?.median ?? Number.NaN);
    rows.push(`| ${measure} | ${stats.map((entry) => cell(entry)).join(" | ")} | ${Number.isFinite(ratio) ? ratio.toFixed(2) : "–"} |`);
  }
  return `${rows.join("\n")}\n\nEach cell: the median, the first to the third quartile, and the lowest to the highest value.\n`;
};

const readSamples = async (folder: string): Promise<CostSample[]> => {
  const files = (await readdir(folder, { recursive: true })).filter((file) => file.endsWith(".jsonl")).sort();
  const lines = (await Promise.all(files.map((file) => readFile(join(folder, file), "utf8")))).flatMap((text) => text.split("\n").filter((line) => line.trim() !== ""));
  return lines.map((line) => {
    const value: unknown = JSON.parse(line);
    if (!isCostSample(value)) throw new Error(`${line} is not a sample of the cost of a build.`);
    return value;
  });
};

if (import.meta.main) {
  const folder = process.argv[2];
  if (folder === undefined) throw new Error("Give the folder of the .jsonl files of the build cost.");
  const samples = await readSamples(folder);
  if (samples.length === 0) throw new Error(`${folder} has no samples.`);
  const text = costTable(samples);
  const stepSummary = process.env["GITHUB_STEP_SUMMARY"];
  if (stepSummary !== undefined) await appendFile(stepSummary, text);
  console.log(text);
}
