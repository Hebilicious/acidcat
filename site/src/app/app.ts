import { defineSite } from "vaporpress/client";
import "../styles/site.css";
import { copyCodeOnClick } from "../theme/copy-code.ts";
import { pageHead } from "./head.ts";
import Layout from "./Layout.vue";

export default defineSite({
  layout: Layout,
  title: (page) => (page.title === "" ? "AcidCat" : `${page.title} | AcidCat`),
  head: pageHead,
  enhance: () => {
    if (!import.meta.env.SSR) copyCodeOnClick();
  },
});
