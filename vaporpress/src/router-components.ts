import type { Plugin } from "vite";

const registrations = ['app.component("RouterLink", RouterLink);', 'app.component("RouterView", RouterView);'];

/**
 * `app.use(router)` registers `RouterLink` and `RouterView` of Vue Router as global components. They render virtual DOM,
 * so they bring the virtual DOM renderer into the bundle of every page. A site imports `RouterView` from vaporpress and
 * writes plain links, so the plugin removes the two registrations from Vue Router.
 */
export const routerWithoutGlobalComponents = (): Plugin => ({
  name: "vaporpress:router-components",
  transform: {
    filter: { id: /[\\/]vue-router[\\/]dist[\\/]vue-router\.js$/ },
    handler(code) {
      const missing = registrations.filter((registration) => !code.includes(registration));
      if (missing.length > 0) throw new Error(`Vue Router no longer has ${missing.join(" and ")} in its install function. Update the plugin vaporpress:router-components.`);
      return { code: registrations.reduce((result, registration) => result.replace(registration, ""), code), map: null };
    },
  },
});
