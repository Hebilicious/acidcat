import { spread } from "./stats.ts";
import type { Spread } from "./stats.ts";

export interface Sample {
  readonly target: string;
  /** A page that Lighthouse loaded, or `interaction` for the probes in the browser. */
  readonly page: string;
  readonly metric: string;
  readonly value: number | string;
  readonly run: number;
}

export interface RunResult {
  readonly suite: string;
  readonly title: string;
  readonly job: string;
  readonly lighthouseVersion: string;
  readonly chromium: string;
  readonly runs: number;
  readonly targets: readonly string[];
  readonly samples: readonly Sample[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const isSample = (value: unknown): value is Sample =>
  isRecord(value) &&
  typeof value["target"] === "string" &&
  typeof value["page"] === "string" &&
  typeof value["metric"] === "string" &&
  (typeof value["value"] === "number" || typeof value["value"] === "string") &&
  typeof value["run"] === "number";

export const isRunResult = (value: unknown): value is RunResult =>
  isRecord(value) &&
  typeof value["suite"] === "string" &&
  typeof value["title"] === "string" &&
  typeof value["job"] === "string" &&
  typeof value["lighthouseVersion"] === "string" &&
  typeof value["chromium"] === "string" &&
  typeof value["runs"] === "number" &&
  Array.isArray(value["targets"]) &&
  value["targets"].every((target) => typeof target === "string") &&
  Array.isArray(value["samples"]) &&
  value["samples"].every(isSample);

interface Metric {
  readonly id: string;
  readonly label: string;
  readonly unit: "score" | "ms" | "cls" | "kB" | "count";
  readonly better: "higher" | "lower";
}

export const lighthouseMetrics: readonly Metric[] = [
  { id: "score", label: "Performance score", unit: "score", better: "higher" },
  { id: "fcp", label: "First Contentful Paint", unit: "ms", better: "lower" },
  { id: "lcp", label: "Largest Contentful Paint", unit: "ms", better: "lower" },
  { id: "cls", label: "Cumulative Layout Shift", unit: "cls", better: "lower" },
  { id: "tbt", label: "Total Blocking Time", unit: "ms", better: "lower" },
  { id: "speedIndex", label: "Speed Index", unit: "ms", better: "lower" },
  { id: "jsTransfer", label: "JavaScript transferred (Brotli)", unit: "kB", better: "lower" },
  { id: "jsDecoded", label: "JavaScript decoded", unit: "kB", better: "lower" },
  { id: "totalTransfer", label: "Total transferred", unit: "kB", better: "lower" },
  { id: "requests", label: "Requests", unit: "count", better: "lower" },
  { id: "thirdPartyRequests", label: "Requests to other origins", unit: "count", better: "lower" },
];

export const interactionMetrics: readonly Metric[] = [
  { id: "ready", label: "Ready: first click handled, from navigation start", unit: "ms", better: "lower" },
  { id: "tabSwitch", label: "Tab switch: press to paint", unit: "ms", better: "lower" },
  { id: "searchOpen", label: "Search: press to search field on screen", unit: "ms", better: "lower" },
  { id: "changeCold", label: "Page change, cold: press to new page on screen", unit: "ms", better: "lower" },
  { id: "changePrefetched", label: "Page change, link prefetched", unit: "ms", better: "lower" },
  { id: "back", label: "Back: call to previous page on screen", unit: "ms", better: "lower" },
];

const navigationMetrics: readonly { readonly id: string; readonly label: string }[] = [
  { id: "changeNavigation", label: "Page change loads" },
  { id: "backNavigation", label: "Back loads" },
];

const format = (value: number, unit: Metric["unit"]): string => {
  if (Number.isNaN(value)) return "–";
  if (unit === "cls") return value.toFixed(3);
  if (unit === "kB") return (value / 1000).toFixed(1);
  return String(Math.round(value));
};

const unitLabel: Readonly<Record<Metric["unit"], string>> = { score: "", ms: " (ms)", cls: "", kB: " (kB)", count: "" };

/** The cell of a measure: its median, and between brackets the range from the first to the third quartile. */
export const cell = (stats: Spread, unit: Metric["unit"]): string => (stats.n === 0 ? "–" : `${format(stats.median, unit)} (${format(stats.q1, unit)}–${format(stats.q3, unit)})`);

const numbers = (samples: readonly Sample[], target: string, page: string, metric: string): number[] =>
  samples.filter((sample) => sample.target === target && sample.page === page && sample.metric === metric).flatMap((sample) => (typeof sample.value === "number" ? [sample.value] : []));

const metricTable = (samples: readonly Sample[], targets: readonly string[], page: string, metrics: readonly Metric[]): string[] => {
  const rows = [`| Metric | ${targets.join(" | ")} |`, `| --- | ${targets.map(() => "---").join(" | ")} |`];
  for (const metric of metrics) {
    const stats = targets.map((target) => spread(numbers(samples, target, page, metric.id)));
    const medians = stats.filter((entry) => entry.n > 0).map((entry) => entry.median);
    if (medians.length === 0) continue;
    const best = metric.better === "higher" ? Math.max(...medians) : Math.min(...medians);
    const cells = stats.map((entry) => {
      const text = cell(entry, metric.unit);
      return entry.n > 0 && medians.length > 1 && format(entry.median, metric.unit) === format(best, metric.unit) ? `**${text}**` : text;
    });
    rows.push(`| ${metric.label}${unitLabel[metric.unit]} | ${cells.join(" | ")} |`);
  }
  return rows;
};

const mostCommon = (values: readonly string[]): string => {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const sorted = [...counts].sort((a, b) => b[1] - a[1]);
  return sorted.map(([value, count]) => `${value} (${count}/${values.length})`).join(", ") || "–";
};

/** The Markdown tables of the results of one suite, from the results of each of its jobs. */
export const summarize = (results: readonly RunResult[]): string => {
  const first = results[0];
  if (first === undefined) return "";
  const samples = results.flatMap((result) => result.samples);
  const targets = first.targets;
  const pages = [...new Set(samples.filter((sample) => sample.page !== "interaction").map((sample) => sample.page))];
  const runs = results.reduce((total, result) => total + result.runs, 0);
  const lines = [
    `## ${first.title}`,
    "",
    `${results.length} jobs × ${first.runs} runs = ${runs} samples for each cell: the median, and the first to the third quartile. Lighthouse ${first.lighthouseVersion}, Chromium ${first.chromium}. The best median of each row is in bold.`,
    "",
  ];
  for (const page of pages) lines.push(`### First visit: \`${page}\`, Lighthouse on mobile`, "", ...metricTable(samples, targets, page, lighthouseMetrics), "");
  lines.push("### In the browser: desktop window, 4× CPU slowdown, slow 4G", "", ...metricTable(samples, targets, "interaction", interactionMetrics));
  for (const metric of navigationMetrics) {
    const kinds = targets.map((target) => mostCommon(samples.filter((sample) => sample.target === target && sample.metric === metric.id).map((sample) => String(sample.value))));
    lines.push(`| ${metric.label} | ${kinds.join(" | ")} |`);
  }
  lines.push("");
  return lines.join("\n");
};
