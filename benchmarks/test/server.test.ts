import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { brotliDecompressSync } from "node:zlib";
import { serve } from "../src/server.ts";

const root = await mkdtemp(join(tmpdir(), "benchmark-server-"));
await mkdir(join(root, "guide", "intro"), { recursive: true });
await mkdir(join(root, "assets"), { recursive: true });
await writeFile(join(root, "index.html"), "<h1>Home</h1>");
await writeFile(join(root, "about.html"), "<h1>About</h1>");
await writeFile(join(root, "guide", "intro", "index.html"), "<h1>Intro</h1>");
await writeFile(join(root, "assets", "app-1234.js"), "console.log(1)");
await writeFile(join(root, "404.html"), "<h1>Not found</h1>");
const server = await serve(root, ["/assets/"]);
after(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

const get = (path: string, headers: Record<string, string> = {}) => fetch(`${server.origin}${path}`, { headers: { "accept-encoding": "br", ...headers } });

test("a path finds its file, its .html file or its index.html", async () => {
  for (const [path, text] of [["/", "Home"], ["/about", "About"], ["/guide/intro/", "Intro"], ["/guide/intro", "Intro"]] as const) {
    const response = await get(path);
    assert.equal(response.status, 200, path);
    assert.match(await response.text(), new RegExp(text));
  }
});

test("text is sent with Brotli, and a path with no file gets 404.html with the status 404", async () => {
  const { status, encoding, body } = await new Promise<{ status: number | undefined; encoding: string | undefined; body: Buffer }>((resolve, reject) => {
    httpGet(`${server.origin}/missing`, { headers: { "accept-encoding": "br" } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, encoding: response.headers["content-encoding"], body: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
  assert.equal(status, 404);
  assert.equal(encoding, "br");
  assert.equal(brotliDecompressSync(body).toString(), "<h1>Not found</h1>");
});

test("hashed assets are kept for a year, pages are checked again, and a known ETag gets 304", async () => {
  const asset = await get("/assets/app-1234.js");
  assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
  const page = await get("/about");
  assert.equal(page.headers.get("cache-control"), "public, max-age=0, must-revalidate");
  const etag = page.headers.get("etag") ?? "";
  assert.equal((await get("/about", { "if-none-match": etag })).status, 304);
});
