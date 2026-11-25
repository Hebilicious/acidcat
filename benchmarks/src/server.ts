import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, relative } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants } from "node:zlib";

const types: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".xml": "application/xml",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".pf_meta": "application/octet-stream",
  ".pf_fragment": "application/octet-stream",
  ".pf_index": "application/octet-stream",
  ".pagefind": "application/octet-stream",
};

const compressible = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg", ".txt", ".md", ".xml", ".wasm"]);

interface Asset {
  readonly body: Buffer;
  readonly brotli: Buffer | undefined;
  readonly etag: string;
}

const brotli = promisify(brotliCompress);

export const readAssets = async (root: string): Promise<ReadonlyMap<string, Asset>> => {
  const files = await readdir(root, { recursive: true, withFileTypes: true });
  const entries = await Promise.all(
    files
      .filter((file) => file.isFile())
      .map(async (file): Promise<[string, Asset]> => {
        const path = join(file.parentPath, file.name);
        const body = await readFile(path);
        const encoded = compressible.has(extname(path)) ? await brotli(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }) : undefined;
        return [`/${relative(root, path)}`, { body, brotli: encoded, etag: `"${createHash("sha1").update(body).digest("base64url")}"` }];
      }),
  );
  return new Map(entries);
};

/** The file of a path: the file itself, `<path>.html` (VitePress with `cleanUrls`, Nuxt), or `<path>/index.html`. */
export const lookup = (assets: ReadonlyMap<string, Asset>, pathname: string): [string, Asset] | undefined => {
  const path = decodeURIComponent(pathname);
  const bare = path.replace(/\/$/, "");
  for (const candidate of [path, `${bare}.html`, `${bare}/index.html`]) {
    const asset = assets.get(candidate);
    if (asset !== undefined) return [candidate, asset];
  }
  return undefined;
};

export interface StaticServer {
  readonly origin: string;
  readonly close: () => Promise<void>;
}

/**
 * Serves a built site from memory, the same way for each framework: Brotli for text, an ETag on each file, a year of
 * cache for the files under `immutable` (the hashed assets of the framework), and a check on each load for the rest.
 */
export const serve = async (root: string, immutable: readonly string[]): Promise<StaticServer> => {
  const assets = await readAssets(root);
  const notFound = assets.get("/404.html");
  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    const found = lookup(assets, pathname);
    const [path, asset] = found ?? ["/404.html", notFound];
    if (asset === undefined) {
      response.writeHead(404).end();
      return;
    }
    const cache = immutable.some((prefix) => pathname.startsWith(prefix)) ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate";
    if (found !== undefined && request.headers["if-none-match"] === asset.etag) {
      response.writeHead(304, { ETag: asset.etag, "Cache-Control": cache }).end();
      return;
    }
    const encoded = asset.brotli !== undefined && (request.headers["accept-encoding"] ?? "").includes("br") ? asset.brotli : undefined;
    response.writeHead(found === undefined ? 404 : 200, {
      "Content-Type": types[extname(path)] ?? "application/octet-stream",
      "Cache-Control": cache,
      ETag: asset.etag,
      Vary: "Accept-Encoding",
      ...(encoded === undefined ? {} : { "Content-Encoding": "br" }),
    });
    response.end(request.method === "HEAD" ? undefined : (encoded ?? asset.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === "string") throw new Error("The server has no port.");
  return { origin: `http://localhost:${address.port}`, close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
};
