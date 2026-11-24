import appModule from "virtual:vaporpress/app";
import { createVaporApp, createVaporSSRApp } from "vue";
import { createWebHistory } from "vue-router";
import { handleHotUpdate, routes } from "vue-router/auto-routes";
import { updateHead } from "./head.ts";
import { isComponent, readSite } from "./site.ts";
import { interceptLinks } from "./links.ts";
import { startPrefetch } from "./prefetch.ts";
import { createSiteRouter, pageOf } from "./router.ts";
import { leanPageChunkMarker } from "./markers.ts";

const site = readSite(appModule);

const hasDefault = (value: unknown): value is { readonly default: unknown } => typeof value === "object" && value !== null && "default" in value;

const router = createSiteRouter(site, createWebHistory(import.meta.env.BASE_URL), routes);
if (import.meta.hot) handleHotUpdate(router);

// The server names the lean chunk of the first page: the same component with its static HTML left out, which hydration takes from the DOM.
const pageChunk = document.querySelector(`link[${leanPageChunkMarker}]`);
if (pageChunk instanceof HTMLLinkElement) {
  const components = router.resolve(location.pathname).matched.at(-1)?.components;
  const loaded: unknown = await import(/* @vite-ignore */ pageChunk.href);
  if (components !== undefined && components !== null && hasDefault(loaded) && isComponent(loaded.default)) {
    components["default"] = loaded.default;
  }
}

const app = pageChunk === null ? createVaporApp(site.layout) : createVaporSSRApp(site.layout);
app.use(router);
await site.enhance?.({ app, router });
interceptLinks(router);
startPrefetch(router);
await router.isReady();
router.afterEach((to, from) => {
  if (to.path !== from.path) updateHead(site, pageOf(to));
});
if (pageChunk === null) updateHead(site, pageOf(router.currentRoute.value));
app.mount("#app");
