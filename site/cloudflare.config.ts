import { bindings, defineConfig } from "cf/config";

export const workerPaths = ["/", "/docs/*", "/examples/*", "/spec/*", "/packages/*", "/mcp", "/mcp/*", "/api", "/api/*", "/.well-known/api-catalog", "/.well-known/ai-catalog.json", "/.well-known/mcp/*"];

export default defineConfig({
  worker: {
    name: "acidcat",
    compatibilityDate: "2026-11-01",
    workersDev: true,
    entrypoint: "./worker/index.ts",
    assets: { notFoundHandling: "404-page", runWorkerFirst: workerPaths },
    env: { ASSETS: bindings.assets() },
  },
});
