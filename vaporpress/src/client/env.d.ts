/// <reference types="vite/client" />

declare module "*.vue" {
  import type { VaporComponent } from "vue";

  const component: VaporComponent;
  export default component;
}

declare module "virtual:vaporpress/app" {
  const site: unknown;
  export default site;
}
