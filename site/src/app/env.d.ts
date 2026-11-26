/// <reference types="vite/client" />
/// <reference types="@hebilicious/cssforge-unplugin/client" />
declare module "*.vue" {
  import type { DefineComponent } from "vue";

  const component: DefineComponent;
  export default component;
}
