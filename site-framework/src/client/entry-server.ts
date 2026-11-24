import appModule from "virtual:site-framework/app";
import { createSSRApp } from "vue";
import type { Component } from "vue";
import { renderToString } from "vue/server-renderer";
import { createMemoryHistory } from "vue-router";
import { routes } from "vue-router/auto-routes";
import type { PageData } from "../page.ts";
import { renderHead } from "./head.ts";
import { readSite } from "./site.ts";
import { createSiteRouter, notFoundRoute, pageOf } from "./router.ts";

const site = readSite(appModule);

/** On the server, the compiler writes each Vapor component as a component that renders to a string. */
const isServerComponent = (value: unknown): value is Component => (typeof value === "object" && value !== null) || typeof value === "function";

const layout: unknown = site.layout;
if (!isServerComponent(layout)) throw new Error("The layout of the site is not a component.");

export interface RenderedPage {
  readonly html: string;
  readonly head: string;
  readonly page: PageData;
}

export const paths = (): readonly string[] => {
  const router = createSiteRouter(site, createMemoryHistory(), routes);
  return router
    .getRoutes()
    .filter((route) => route.name !== notFoundRoute && !route.path.includes(":"))
    .map((route) => route.path);
};

export const render = async (path: string): Promise<RenderedPage> => {
  const router = createSiteRouter(site, createMemoryHistory(), routes);
  const app = createSSRApp(layout);
  app.use(router);
  await site.enhance?.({ app, router });
  await router.push(path);
  await router.isReady();
  const html = await renderToString(app);
  const page = pageOf(router.currentRoute.value);
  return { html, head: renderHead(site, page), page };
};
