/// <reference types="vite/client" />

declare module "*.vue" {
  import type { VaporComponent } from "vue";

  const component: VaporComponent;
  export default component;
}

declare module "virtual:site-framework/app" {
  const site: unknown;
  export default site;
}
