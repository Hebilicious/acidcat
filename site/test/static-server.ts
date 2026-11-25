import { readdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, normalize } from "node:path";
import { contentType } from "../src/lib/content-types.ts";

/** The build that the tests read: `dist/` of VitePress, or the build of vaporpress when `SITE_BUILD` is `framework`. */
export const dist = new URL(process.env["SITE_BUILD"] === "framework" ? "../.out/framework/" : "../dist/", import.meta.url).pathname;

export const builtPages = async (): Promise<string[]> => {
  const entries = await readdir(dist, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".html")).map((entry) => join(entry.parentPath, entry.name));
};

const resolveFile = async (root: string, url: string): Promise<string | undefined> => {
  const path = normalize(join(root, decodeURIComponent(new URL(url, "http://site").pathname)));
  if (!path.startsWith(root)) return undefined;
  const info = await stat(path).catch(() => undefined);
  if (info?.isDirectory() === true) return join(path, "index.html");
  return info === undefined ? undefined : path;
};

export interface StaticServer {
  readonly origin: string;
  readonly close: () => Promise<void>;
}

export const serveDist = async (root = dist): Promise<StaticServer> => {
  const server = createServer((request, response) => {
    resolveFile(root, request.url ?? "/")
      .then(async (path) => {
        if (path === undefined) throw new Error("not found");
        const body = await readFile(path);
        response.writeHead(200, { "content-type": contentType(path) ?? "application/octet-stream" });
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
