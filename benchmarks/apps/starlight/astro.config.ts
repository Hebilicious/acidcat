import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { sidebar } from "../../src/fixture.ts";

export default defineConfig({
  integrations: [
    starlight({
      title: "Example Docs",
      sidebar: sidebar.map((group) => ({ label: group.label, items: group.items.map((id) => id.replace(/\/index$/, "")) })),
    }),
  ],
});
