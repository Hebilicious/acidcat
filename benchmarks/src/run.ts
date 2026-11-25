import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { measureInteractions } from "./browser.ts";
import { metricsOf, runLighthouse } from "./lighthouse.ts";
import type { Sample, RunResult } from "./results.ts";
import { serve } from "./server.ts";
import type { StaticServer } from "./server.ts";
import { fixtureSuite, siteSuite } from "./targets.ts";
import type { Suite, Target } from "./targets.ts";

const { values } = parseArgs({
  options: {
    suite: { type: "string", default: "fixture" },
    runs: { type: "string", default: "5" },
    out: { type: "string", default: "results" },
    job: { type: "string", default: "local" },
    "site-framework": { type: "string" },
    "site-vitepress": { type: "string" },
    "site-astro": { type: "string" },
  },
});

const suiteOf = (): Suite => {
  if (values.suite === "fixture") return fixtureSuite;
  const framework = values["site-framework"];
  const vitepress = values["site-vitepress"];
  const astro = values["site-astro"];
  if (values.suite !== "site" || framework === undefined || vitepress === undefined || astro === undefined) {
    throw new Error("Use --suite fixture, or --suite site with --site-framework, --site-vitepress and --site-astro.");
  }
  return siteSuite({ framework, vitepress, astro });
};

const freePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address: AddressInfo | string | null = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === "string") throw new Error("No free port.");
  return address.port;
};

/** Each page that a probe or Lighthouse loads must answer 200, so that a broken build fails before it is measured. */
const checkPages = async (target: Target, origin: string): Promise<void> => {
  const paths = new Set([...Object.values(target.pages), target.tabs.path, target.change.from, ...(target.search === undefined ? [] : [target.search.path])]);
  for (const path of paths) {
    const response = await fetch(`${origin}${path}`);
    if (response.status !== 200) throw new Error(`${target.name}: ${path} answers ${response.status}.`);
  }
};

const suite = suiteOf();
const runs = Number(values.runs);
const out = join(values.out, `${suite.name}-${values.job}`);
await mkdir(join(out, "lighthouse"), { recursive: true });

const servers = new Map<string, StaticServer>();
for (const target of suite.targets) {
  const server = await serve(target.root, target.immutable);
  await checkPages(target, server.origin);
  servers.set(target.name, server);
}

const port = await freePort();
const browser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
const chromiumVersion = browser.version();
const samples: Sample[] = [];
let lighthouseVersion = "";

try {
  for (let run = 1; run <= runs; run += 1) {
    const shift = (run - 1) % suite.targets.length;
    const order = [...suite.targets.slice(shift), ...suite.targets.slice(0, shift)];
    for (const target of order) {
      const server = servers.get(target.name);
      if (server === undefined) throw new Error(`No server for ${target.name}.`);
      const add = (page: string, metric: string, value: number | string | undefined) => {
        if (value !== undefined) samples.push({ target: target.name, page, metric, value, run });
      };
      for (const [page, path] of Object.entries(target.pages)) {
        const { result, json } = await runLighthouse(`${server.origin}${path}`, port);
        lighthouseVersion = result.lighthouseVersion;
        if (run === 1) await writeFile(join(out, "lighthouse", `${target.name.replace(/[^a-z0-9]+/gi, "-")}-${page}.json`), json);
        for (const [metric, value] of Object.entries(metricsOf(result, server.origin))) add(page, metric, value);
      }
      const interactions = await measureInteractions(browser, server.origin, target);
      for (const [metric, value] of Object.entries(interactions)) add("interaction", metric, value);
      console.log(`run ${run}/${runs}: ${target.name} done`);
    }
  }
} finally {
  await browser.close();
  for (const server of servers.values()) await server.close();
}

const result: RunResult = { suite: suite.name, title: suite.title, job: values.job, lighthouseVersion, chromium: chromiumVersion, runs, targets: suite.targets.map((target) => target.name), samples };
await writeFile(join(out, "results.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(`Wrote ${samples.length} samples to ${out}.`);
