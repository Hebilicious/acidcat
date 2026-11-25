import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../assets/favicon.svg", import.meta.url));

export interface Favicon {
  readonly href: string;
  readonly write: (dist: string) => Promise<void>;
}

/**
 * The icon of every page, at a URL with a hash, so that the browser keeps it for a year. A browser that asks for
 * `/favicon.ico` without reading the page gets a redirect to it, not the 404 page.
 */
export const readFavicon = async (): Promise<Favicon> => {
  const svg = await readFile(source);
  const href = `/assets/favicon.${createHash("sha256").update(svg).digest("base64url").slice(0, 8)}.svg`;
  return {
    href,
    write: async (dist) => {
      await writeFile(join(dist, href), svg);
      await appendFile(join(dist, "_redirects"), `/favicon.ico ${href} 302\n`);
    },
  };
};
