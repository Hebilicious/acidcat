import { defineRouteMiddleware } from "@astrojs/starlight/route-data";
import { sectionOf, socialImage } from "./lib/social.ts";

const sections: Record<string, string> = { "/docs/": "Docs", "/spec/": "Specification" };

export const onRequest = defineRouteMiddleware((context) => {
  const route = context.locals.starlightRoute;
  const path = context.url.pathname;
  for (const attrs of socialImage(sectionOf(path))) route.head.push({ tag: "meta", attrs, content: "" });
  const section = Object.entries(sections).find(([prefix]) => path.startsWith(prefix));
  if (section === undefined) {
    route.hasSidebar = false;
    route.sidebar = [];
    return;
  }
  const group = route.sidebar.find((entry) => entry.type === "group" && entry.label === section[1]);
  if (group?.type === "group") route.sidebar = group.entries;
});
