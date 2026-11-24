import { readdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";

export const dist = new URL("../dist/", import.meta.url).pathname;

export const builtPages = async (): Promise<string[]> => {
  const entries = await readdir(dist, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".html")).map((entry) => join(entry.parentPath, entry.name));
};
const types: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".webp": "image/webp",
  ".png": "image/png",
  ".avif": "image/avif",
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".gz": "application/gzip",
};

const resolveFile = async (url: string): Promise<string | undefined> => {
  const path = normalize(join(dist, decodeURIComponent(new URL(url, "http://site").pathname)));
  if (!path.startsWith(dist)) return undefined;
  const info = await stat(path).catch(() => undefined);
  if (info?.isDirectory() === true) return join(path, "index.html");
  return info === undefined ? undefined : path;
};

export interface StaticServer {
  readonly origin: string;
  readonly close: () => Promise<void>;
}

export const serveDist = async (): Promise<StaticServer> => {
  const server = createServer((request, response) => {
    resolveFile(request.url ?? "/")
      .then(async (path) => {
        if (path === undefined) throw new Error("not found");
        const body = await readFile(path);
        response.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
        response.end(body);
      })
      .catch(() => {
        response.writeHead(404);
        response.end();
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === "string") throw new Error("The server has no port.");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};
