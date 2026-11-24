import { globSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import type { Options as VueOptions } from "@vitejs/plugin-vue";
import type { Plugin, PluginOption, ViteBuilder } from "vite";
import vueRouter from "vue-router/vite";
import { dataPlugin } from "./data.ts";
import { leanTemplates } from "./lean.ts";
import { compileMarkdown } from "./markdown.ts";
import type { MarkdownOptions } from "./markdown.ts";
import { prerender } from "./prerender.ts";
import type { DocumentOptions } from "./prerender.ts";

export interface VaporpressOptions extends DocumentOptions {
  /** The folder of the site. The default is the folder where Vite runs. */
  readonly root?: string;
  /** The module whose default export is the site, from `defineSite`. The path is relative to the root of Vite. */
  readonly app: string;
  /** The folder of the pages, relative to the root of Vite. Each `.md` and `.vue` file in it is a route. */
  readonly pages?: string;
  readonly markdown?: MarkdownOptions;
  /** Pages whose files are outside the folder of the pages, such as the files of a specification in another folder of the repository. */
  readonly extraPages?: () => readonly ExtraPage[] | Promise<readonly ExtraPage[]>;
  /** Options for `@vitejs/plugin-vue`. The framework compiles every component in Vapor mode. */
  readonly vue?: VueOptions;
}

export interface ExtraPage {
  /** The path of the route, such as `/spec/catalog`. */
  readonly path: string;
  /** The absolute path of the `.md` or `.vue` file of the page. */
  readonly file: string;
}

const clientEntry = fileURLToPath(new URL("./client/entry-client.ts", import.meta.url));
const serverEntry = fileURLToPath(new URL("./client/entry-server.ts", import.meta.url));
const appModule = "virtual:vaporpress/app";
const resolvedAppModule = `\0${appModule}`;
export const clientEntryName = "vaporpress";
const leanQuery = "?lean";

const splitId = (id: string): { readonly file: string; readonly query: string } => {
  const index = id.indexOf("?");
  return index === -1 ? { file: id, query: "" } : { file: id.slice(0, index), query: id.slice(index) };
};

const isPageFile = (file: string): boolean => file.endsWith(".md") || file.endsWith(".vue");

const devDocument = (options: DocumentOptions): string =>
  [
    "<!doctype html>",
    `<html lang="${options.lang ?? "en"}">`,
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    options.headHtml ?? "",
    "</head>",
    `<body><div id="app"></div><script type="module" src="/@fs${clientEntry}"></script></body>`,
    "</html>",
  ].join("");

/** The Vite plugins of a site: Markdown pages, Vue in Vapor mode, routes from files, the dev server and the static build. */
export const vaporpress = (options: VaporpressOptions): PluginOption[] => {
  const siteRoot = resolve(options.root ?? process.cwd());
  const pagesDir = resolve(siteRoot, options.pages ?? "pages");
  const routeFiles = new Map<string, string>();
  let extraPages: Promise<readonly ExtraPage[]> | undefined;
  const readExtraPages = (): Promise<readonly ExtraPage[]> => {
    extraPages ??= Promise.resolve(options.extraPages?.() ?? []).then((pages) => {
      for (const page of pages) routeFiles.set(page.path, relative(siteRoot, page.file));
      return pages;
    });
    return extraPages;
  };

  const markdown: Plugin = {
    name: "vaporpress:markdown",
    enforce: "pre",
    async transform(code, id) {
      const { file, query } = splitId(id);
      if (!file.endsWith(".md") || (query !== "" && query !== leanQuery)) return undefined;
      const { sfc } = await compileMarkdown(code, file, options.markdown);
      return { code: sfc, map: null };
    },
    handleHotUpdate(context) {
      if (!context.file.endsWith(".md")) return;
      const read = context.read;
      context.read = async () => (await compileMarkdown(await read(), context.file, options.markdown)).sfc;
    },
  };

  const core: Plugin = {
    name: "vaporpress:core",
    sharedDuringBuild: true,
    config() {
      return {
        root: siteRoot,
        appType: "custom",
        builder: { sharedConfigBuild: true },
        build: { manifest: true },
        environments: {
          client: { build: { manifest: true, rollupOptions: { input: { [clientEntryName]: clientEntry } } } },
          ssr: {
            build: {
              outDir: join(siteRoot, "node_modules/.vaporpress/server"),
              emptyOutDir: true,
              copyPublicDir: false,
              rollupOptions: { input: { server: serverEntry } },
            },
          },
        },
      };
    },
    resolveId(id) {
      return id === appModule ? resolvedAppModule : undefined;
    },
    load(id) {
      return id === resolvedAppModule ? `export { default } from ${JSON.stringify(resolve(siteRoot, options.app))};` : undefined;
    },
    async buildStart() {
      if (this.environment.name !== "client" || this.environment.mode !== "build") return;
      const files = [...globSync("**/*.{md,vue}", { cwd: pagesDir }).map((file) => join(pagesDir, file)), ...(await readExtraPages()).map((page) => page.file)];
      for (const file of files) this.emitFile({ type: "chunk", id: `${file}${leanQuery}`, preserveSignature: "exports-only" });
    },
    transform: {
      order: "post",
      handler(code, id) {
        const { file, query } = splitId(id);
        if (query !== leanQuery || !isPageFile(file)) return undefined;
        return { code: leanTemplates(code), map: null };
      },
    },
    configureServer(server) {
      return () => {
        server.middlewares.use((request, response, next) => {
          const accept = request.headers.accept ?? "";
          if (request.method !== "GET" || !accept.includes("text/html")) return next();
          void server.transformIndexHtml(request.url ?? "/", devDocument(options)).then((html) => {
            response.setHeader("Content-Type", "text/html");
            response.end(html);
          }, next);
        });
      };
    },
    async buildApp(builder: ViteBuilder) {
      const { client, ssr } = builder.environments;
      if (client === undefined || ssr === undefined) throw new Error("The site needs the client and the ssr environments of Vite.");
      await builder.build(client);
      await builder.build(ssr);
      await prerender({
        root: siteRoot,
        outDir: resolve(siteRoot, client.config.build.outDir),
        serverEntry: join(resolve(siteRoot, ssr.config.build.outDir), "server.js"),
        routeFiles,
        options,
        clientEntryName,
      });
    },
  };

  return [
    markdown,
    vueRouter({
      root: siteRoot,
      routesFolder: [{ src: pagesDir }],
      extensions: [".vue", ".md"],
      dts: false,
      async beforeWriteFiles(rootRoute) {
        for (const page of await readExtraPages()) rootRoute.insert(page.path.replace(/^\//, ""), page.file);
      },
      extendRoute(route) {
        const component = route.components.get("default");
        if (component !== undefined) routeFiles.set(route.fullPath, relative(siteRoot, component));
      },
    }),
    vue({ ...options.vue, include: [/\.vue$/, /\.md$/], features: { ...options.vue?.features, vapor: true } }),
    dataPlugin(),
    core,
  ];
};
