import { defineSite } from "framework/client";
import { copyCodeOnClick } from "./copy-code.ts";
import Layout from "./Layout.vue";
import "./style.css";

export default defineSite({
  layout: Layout,
  title: (page) => (page.path === "/" ? page.title : `${page.title} | Example Docs`),
  head: (page) => [{ tag: "meta", attrs: { name: "description", content: page.description ?? "" } }],
  enhance: () => {
    if (!import.meta.env.SSR) copyCodeOnClick();
  },
});
