import { copyCodeOnClick } from "framework/behaviors";
import { defineSite } from "framework/client";
import Layout from "./Layout.vue";
import { listenToTabGroups } from "./tabs.ts";
import "./style.css";

export default defineSite({
  layout: Layout,
  title: (page) => (page.path === "/" ? page.title : `${page.title} | Example Docs`),
  head: (page) => [{ tag: "meta", attrs: { name: "description", content: page.description ?? "" } }],
  enhance: () => {
    if (import.meta.env.SSR) return;
    listenToTabGroups();
    copyCodeOnClick({ button: ".copy-code", code: (button) => button.parentElement?.querySelector("pre code"), copied: (button, copied) => button.setAttribute("aria-label", copied ? "Copied" : "Copy code") });
  },
});
