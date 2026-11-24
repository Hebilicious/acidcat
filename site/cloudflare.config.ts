import { defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "acidcat",
    compatibilityDate: "2026-11-01",
    workersDev: true,
    assets: { notFoundHandling: "404-page" },
  },
});
