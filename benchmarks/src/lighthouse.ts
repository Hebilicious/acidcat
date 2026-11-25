import lighthouse from "lighthouse";
import type { Result } from "lighthouse";

export type LighthouseMetrics = {
  readonly score: number;
  readonly fcp: number;
  readonly lcp: number;
  readonly cls: number;
  readonly tbt: number;
  readonly speedIndex: number;
  readonly jsTransfer: number;
  readonly jsDecoded: number;
  readonly totalTransfer: number;
  readonly requests: number;
  readonly thirdPartyRequests: number;
};

interface NetworkRequest {
  readonly url: string;
  readonly transferSize: number;
  readonly resourceSize: number;
  readonly resourceType: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const isNetworkRequest = (value: unknown): value is NetworkRequest =>
  isRecord(value) && typeof value["url"] === "string" && typeof value["transferSize"] === "number" && typeof value["resourceSize"] === "number" && typeof value["resourceType"] === "string";

const numeric = (result: Result, id: string): number => {
  const value = result.audits[id]?.numericValue;
  if (value === undefined) throw new Error(`Lighthouse gave no value for ${id}.`);
  return value;
};

export const networkRequests = (result: Result): readonly NetworkRequest[] => {
  const details: unknown = result.audits["network-requests"]?.details;
  const items = isRecord(details) && Array.isArray(details["items"]) ? details["items"] : [];
  return items.filter(isNetworkRequest).filter((request) => !request.url.startsWith("data:"));
};

export const metricsOf = (result: Result, origin: string): LighthouseMetrics => {
  const requests = networkRequests(result);
  const scripts = requests.filter((request) => request.resourceType === "Script");
  const sum = (list: readonly NetworkRequest[], key: "transferSize" | "resourceSize") => list.reduce((total, request) => total + request[key], 0);
  return {
    score: Math.round((result.categories["performance"]?.score ?? 0) * 100),
    fcp: numeric(result, "first-contentful-paint"),
    lcp: numeric(result, "largest-contentful-paint"),
    cls: numeric(result, "cumulative-layout-shift"),
    tbt: numeric(result, "total-blocking-time"),
    speedIndex: numeric(result, "speed-index"),
    jsTransfer: sum(scripts, "transferSize"),
    jsDecoded: sum(scripts, "resourceSize"),
    totalTransfer: sum(requests, "transferSize"),
    requests: requests.length,
    thirdPartyRequests: requests.filter((request) => !request.url.startsWith(origin)).length,
  };
};

/** Runs Lighthouse on mobile with its default simulated throttling, in the Chromium that listens on `port`. */
export const runLighthouse = async (url: string, port: number): Promise<{ readonly result: Result; readonly json: string }> => {
  const runner = await lighthouse(url, { port, output: "json", logLevel: "error", onlyCategories: ["performance"] });
  if (runner === undefined) throw new Error(`Lighthouse gave no result for ${url}.`);
  const json = Array.isArray(runner.report) ? (runner.report[0] ?? "") : runner.report;
  return { result: runner.lhr, json };
};
