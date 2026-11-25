import { defineConfig } from "vitepress";
import { readFixture, sidebar } from "../../../src/fixture.ts";

const pages = await readFixture();
const titleOf = (id: string): string => pages.find((page) => page.id === id)?.title ?? id;
const linkOf = (id: string): string => `/${id.replace(/index$/, "")}`;

export default defineConfig({
  title: "Example Docs",
  description: "A small documentation site.",
  srcDir: "docs",
  cleanUrls: true,
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/" },
      { text: "Reference", link: "/reference/" },
    ],
    sidebar: sidebar.map((group) => ({ text: group.label, items: group.items.map((id) => ({ text: titleOf(id), link: linkOf(id) })) })),
    search: { provider: "local" },
  },
});
