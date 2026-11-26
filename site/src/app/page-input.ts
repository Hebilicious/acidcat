import { preloadSearchIndex } from "vaporpress/search";
import { searchModuleHref } from "./search-module.ts";
import { openSearchOnInput } from "./search-input.ts";
import { selectTabsOnInput } from "./tabs.ts";

selectTabsOnInput();
openSearchOnInput(() => {
  preloadSearchIndex();
  const href = searchModuleHref();
  if (href === undefined) return;
  const link = document.createElement("link");
  link.rel = "modulepreload";
  link.href = href;
  document.head.append(link);
});
