import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";

const types: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

export const serve = async (dist: string): Promise<{ readonly origin: string; readonly server: Server }> => {
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    const path = normalize(join(dist, pathname));
    const file = [path, join(path, "index.html")].find((candidate) => candidate.startsWith(dist) && isFile(candidate));
    if (file === undefined) {
      response.writeHead(404, { "Content-Type": types[".html"] });
      createReadStream(join(dist, "404.html")).pipe(response);
      return;
    }
    response.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === "string") throw new Error("The server has no port.");
  return { origin: `http://127.0.0.1:${address.port}`, server };
};
