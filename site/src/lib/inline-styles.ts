import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const stylesheet = /<link rel="preload stylesheet" href="(\/assets\/[^"]+\.css)" as="style">/g;

/** Writes the stylesheet of the site into each page, so that no request for a stylesheet blocks the first render. */
export const inlineStyles = async (dist: string): Promise<void> => {
  const entries = await readdir(dist, { withFileTypes: true, recursive: true });
  const pages = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".html")).map((entry) => join(entry.parentPath, entry.name));
  const sheets = new Map<string, string>();
  const sheet = async (href: string): Promise<string> => {
    const cached = sheets.get(href);
    if (cached !== undefined) return cached;
    const css = await readFile(join(dist, href), "utf8");
    sheets.set(href, css);
    return css;
  };
  await Promise.all(
    pages.map(async (page) => {
      const html = await readFile(page, "utf8");
      const hrefs = [...html.matchAll(stylesheet)].map((match) => match[1] ?? "");
      if (hrefs.length === 0) throw new Error(`${page} links no stylesheet. Change site/src/lib/inline-styles.ts to match the HTML of VitePress.`);
      let inlined = html;
      for (const href of hrefs) {
        const css = await sheet(href);
        inlined = inlined.replace(`<link rel="preload stylesheet" href="${href}" as="style">`, () => `<style>${css}</style>`);
      }
      await writeFile(page, inlined);
    }),
  );
};
