import assert from "node:assert/strict";
import { test } from "node:test";

import { conform, serve } from "@acid-cat/cli";
import { build } from "esbuild";

test("the Effect core passes acid-cat conform through WebMCP in Chromium", async () => {
  const bundled = await build({
    entryPoints: [new URL("./fixture-page.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
  });
  const [output] = bundled.outputFiles;
  assert.ok(output !== undefined, "esbuild wrote no file.");
  const script = output.text;
  const served = await serve({
    "/page": async (request) =>
      new URL(request.url).pathname === "/page/fixture.js"
        ? new Response(script, { headers: { "Content-Type": "text/javascript" } })
        : new Response('<!doctype html><script type="module" src="/page/fixture.js"></script>', {
            headers: { "Content-Type": "text/html" },
          }),
  });
  try {
    const results = await conform({ webmcp: `${served.url}/page` });
    const failed = results.filter((result) => !result.passed);
    assert.deepEqual(failed, [], failed.map((result) => `${result.binding}: ${result.name}: ${result.detail}`).join("\n"));
    assert.ok(results.length >= 8);
  } finally {
    await served.close();
  }
});
