import { defineSite } from "vaporpress/client";
import Layout from "./Layout.vue";

export default defineSite({
  layout: Layout,
  title: (page) => (page.title === "" ? "Fixture" : `${page.title} | Fixture`),
  head: (page) => [
    { tag: "meta", attrs: { name: "description", content: page.description ?? "A fixture site." } },
    { tag: "link", attrs: { rel: "canonical", href: `https://fixture.test${page.path}` } },
  ],
});
