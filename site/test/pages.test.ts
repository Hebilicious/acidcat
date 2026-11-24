import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { siteUrl as site } from "../src/lib/social.ts";
import { builtPages, dist } from "./static-server.ts";

test("every link to another website opens in a new tab", async () => {
  const offenders: string[] = [];
  for (const file of await builtPages()) {
    const html = await readFile(file, "utf8");
    for (const match of html.matchAll(/<a\b[^>]*>/g)) {
      const tag = match[0];
      const href = /\shref="(https?:\/\/[^"]+)"/.exec(tag)?.[1];
      if (href === undefined || href.startsWith(site)) continue;
      if (!/\starget="_blank"/.test(tag) || !/\srel="[^"]*noopener/.test(tag)) offenders.push(`${file.slice(dist.length)}: ${href}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("every page has an absolute social image of 1200 by 630 that exists in the build", async () => {
  const offenders: string[] = [];
  for (const file of await builtPages()) {
    const html = await readFile(file, "utf8");
    const image = /<meta property="og:image" content="([^"]+)"/.exec(html)?.[1];
    const card = /<meta name="twitter:card" content="summary_large_image"/.test(html);
    const size = /<meta property="og:image:width" content="1200"/.test(html) && /<meta property="og:image:height" content="630"/.test(html);
    if (image === undefined || !image.startsWith(`${site}/og/`) || !card || !size) {
      offenders.push(file.slice(dist.length));
      continue;
    }
    await readFile(join(dist, image.slice(site.length))).catch(() => offenders.push(`${file.slice(dist.length)}: ${image} is missing`));
  }
  assert.deepEqual(offenders, []);
});

test("every page asks the browser to prerender the pages of the site that a reader is about to open", async () => {
  const offenders: string[] = [];
  for (const file of await builtPages()) {
    const html = await readFile(file, "utf8");
    const rules = /<script type="speculationrules">([^<]*)<\/script>/.exec(html)?.[1];
    if (rules === undefined) {
      offenders.push(`${file.slice(dist.length)}: no speculation rules`);
      continue;
    }
    const parsed: unknown = JSON.parse(rules);
    const text = JSON.stringify(parsed);
    if (!text.includes('"prerender"') || !text.includes('"href_matches":"/*"') || !text.includes("target=_blank")) offenders.push(`${file.slice(dist.length)}: ${text}`);
  }
  assert.deepEqual(offenders, []);
});

test("each redirect leads to a page of the build", async () => {
  const rules = (await readFile(join(dist, "_redirects"), "utf8")).split("\n").filter((line) => line.trim() !== "");
  const missing: string[] = [];
  for (const rule of rules) {
    const [, to = ""] = rule.split(/\s+/);
    const page = to.replace(/:splat$/, "");
    await readFile(join(dist, page, "index.html")).catch(() => missing.push(rule));
  }
  assert.deepEqual(missing, []);
});
