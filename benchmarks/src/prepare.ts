import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureDir, readFixture, toDocus, toFramework, toStarlight, toVitePress } from "./fixture.ts";
import type { FixturePage, Output } from "./fixture.ts";

const apps = fileURLToPath(new URL("../apps/", import.meta.url));
const hero = fileURLToPath(new URL("hero.png", fixtureDir));

const targets: readonly { readonly pages: string; readonly write: (page: FixturePage) => Output; readonly image: string }[] = [
  { pages: "framework/pages", write: toFramework, image: "framework/pages/hero.png" },
  { pages: "vitepress/docs", write: toVitePress, image: "vitepress/docs/hero.png" },
  { pages: "starlight/src/content/docs", write: toStarlight, image: "starlight/src/content/docs/hero.png" },
  { pages: "nuxt/content", write: toDocus, image: "nuxt/public/hero.png" },
];

const pages = await readFixture();
for (const target of targets) {
  await rm(join(apps, target.pages), { recursive: true, force: true });
  for (const page of pages) {
    const output = target.write(page);
    const file = join(apps, target.pages, output.file);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, output.source);
  }
  if (target.pages === "framework/pages") await writeFile(join(apps, target.pages, "404.md"), "---\ntitle: Page not found\n---\n\n# Page not found\n");
  await mkdir(dirname(join(apps, target.image)), { recursive: true });
  await copyFile(hero, join(apps, target.image));
}
console.log(`Wrote ${pages.length} pages for each of ${targets.length} apps.`);
