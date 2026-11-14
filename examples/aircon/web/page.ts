/**
 * The web page of the air conditioner, on the server: its markup, and a web request handler that serves the markup and
 * the bundled script of one core. `core-ts/page.ts` and `core-effect/page.ts` are the scripts. esbuild bundles each one
 * for the browser when the handler is made.
 */
import { build } from "esbuild";

export type WebHandler = (request: Request) => Response;

/** The elements that `controls.ts` reads and writes. */
const markup = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Living-room air conditioner</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; }
  dt { font-weight: 600; }
  section { margin-block: 1.5rem; }
  .row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin-block: 0.5rem; }
  li[data-available="false"] { color: #888; }
</style>
</head>
<body>
<h1>Living-room air conditioner</h1>
<p>Core: <span id="core"></span></p>
<section aria-labelledby="status-title">
  <h2 id="status-title">Status</h2>
  <dl>
    <dt>Power</dt><dd id="status-power"></dd>
    <dt>Mode</dt><dd id="status-mode"></dd>
    <dt>Fan</dt><dd id="status-fan"></dd>
    <dt>Target</dt><dd id="status-target"></dd>
    <dt>Room</dt><dd id="status-room"></dd>
  </dl>
</section>
<section aria-labelledby="controls-title">
  <h2 id="controls-title">Controls</h2>
  <div class="row"><button id="power" type="button">Turn on</button></div>
  <div class="row"><label for="mode">Mode</label>
    <select id="mode"><option>cool</option><option>heat</option><option>dry</option><option>fan</option><option>auto</option></select></div>
  <div class="row"><label for="celsius">Target °C</label>
    <input id="celsius" type="number" min="16" max="31" step="0.5" value="22">
    <button id="set-temperature" type="button">Set</button></div>
  <div class="row"><label for="fan">Fan</label>
    <select id="fan"><option>auto</option><option>low</option><option>medium</option><option>high</option></select></div>
  <div class="row"><button id="firmware" type="button">Update firmware</button></div>
  <div class="row"><label><input id="online" type="checkbox" checked> The unit is online (simulation)</label></div>
  <p>Last call: <output id="result"></output></p>
</section>
<section aria-labelledby="webmcp-title">
  <h2 id="webmcp-title">WebMCP</h2>
  <p>Status: <span id="webmcp-phase">loading</span> <span id="webmcp-message"></span></p>
  <ul id="tools"></ul>
</section>
<script type="module" src="page.js"></script>
</body>
</html>
`;

/**
 * Bundle a page script for the browser, and give a handler that serves the page at each path that ends with `/`, and
 * the script at each path that ends with `/page.js`.
 */
export async function pageHandler(entry: URL): Promise<WebHandler> {
  const bundled = await build({ entryPoints: [entry.pathname], bundle: true, write: false, format: "esm", platform: "browser" });
  const [output] = bundled.outputFiles;
  if (output === undefined) throw new Error(`esbuild wrote no output for ${entry.pathname}.`);
  const script = output.text;
  return (request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/page.js")) return new Response(script, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
    if (path.endsWith("/")) return new Response(markup, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    return new Response("Not found", { status: 404 });
  };
}

/** The host and port of an address such as `127.0.0.1:8080` or `[::1]:8080`, or `undefined` if it is not one. */
export function addressOf(text: string): { readonly hostname: string; readonly port: number } | undefined {
  const match = /^(.+):([0-9]+)$/.exec(text);
  const port = Number(match?.[2]);
  if (match?.[1] === undefined || !Number.isInteger(port) || port > 65_535) return undefined;
  return { hostname: match[1].replace(/^\[(.*)\]$/, "$1"), port };
}
