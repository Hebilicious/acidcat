import { readdir, writeFile } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";

const pagePaths = async (dist: string): Promise<string[]> => {
  const entries = await readdir(dist, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name === "index.html")
    .map((entry) => `/${relative(dist, entry.parentPath).split(sep).join(posix.sep)}/`.replace(/^\/+/, "/"))
    .sort();
};

/** Writes /sitemap-index.xml and /sitemap-0.xml with every page of the build. */
export const writeSitemap = async (dist: string, origin: string): Promise<void> => {
  const urls = (await pagePaths(dist)).map((path) => `<url><loc>${origin}${path}</loc></url>`).join("");
  await writeFile(join(dist, "sitemap-0.xml"), `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
  await writeFile(
    join(dist, "sitemap-index.xml"),
    `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${origin}/sitemap-0.xml</loc></sitemap></sitemapindex>`,
  );
};
