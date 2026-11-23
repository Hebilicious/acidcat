import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://acidcat.hebilicious.workers.dev",
  integrations: [
    starlight({
      title: "AcidCat",
      description: "Describe what your application can do once. Serve it as a CLI, an MCP server, an HTTP API and typed client code.",
      logo: { src: "./src/assets/mark.svg", alt: "AcidCat" },
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/Hebilicious/acidcat" }],
      customCss: ["./src/styles/starlight.css"],
    }),
  ],
});
