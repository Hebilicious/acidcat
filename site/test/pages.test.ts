import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { configFiles, contentType } from "../src/lib/content-types.ts";
import { siteUrl as site } from "../src/lib/social.ts";
import { builtPages, dist } from "./static-server.ts";

test("the build writes the page of each URL in test/routes.txt, and no other page", async () => {
  const expected = (await readFile(new URL("routes.txt", import.meta.url), "utf8")).split("\n").filter((line) => line !== "");
  const built = (await builtPages()).map((file) => `/${file.slice(dist.length).replace(/index\.html$/, "")}`).sort();
  assert.deepEqual(built, expected, "A page is gone, or a new page is not in test/routes.txt yet.");
});

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

test("each redirect leads to a page or a file of the build", async () => {
  const rules = (await readFile(join(dist, "_redirects"), "utf8")).split("\n").filter((line) => line.trim() !== "");
  const missing: string[] = [];
  for (const rule of rules) {
    const [, to = ""] = rule.split(/\s+/);
    const target = to.endsWith("/") || to.endsWith(":splat") ? join(to.replace(/:splat$/, ""), "index.html") : to;
    await readFile(join(dist, target)).catch(() => missing.push(rule));
  }
  assert.deepEqual(missing, []);
});

test("every page declares the icon of the site, and /favicon.ico leads to it", async () => {
  const redirects = await readFile(join(dist, "_redirects"), "utf8");
  const icon = /^\/favicon\.ico (\/assets\/favicon\.[\w-]+\.svg) 302$/m.exec(redirects)?.[1];
  if (icon === undefined) throw new Error("No redirect from /favicon.ico to the icon.");
  const offenders: string[] = [];
  for (const file of await builtPages()) {
    if (!(await readFile(file, "utf8")).includes(`<link rel="icon" type="image/svg+xml" href="${icon}">`)) offenders.push(file.slice(dist.length));
  }
  assert.deepEqual(offenders, []);
});

test("each file of the build has its media type in the table of the servers", async () => {
  const files = (await readdir(dist, { recursive: true, withFileTypes: true })).filter((file) => file.isFile() && !configFiles.includes(file.name));
  assert.deepEqual(files.map((file) => join(file.parentPath, file.name).slice(dist.length)).filter((path) => contentType(path) === undefined), []);
});
