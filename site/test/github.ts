import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright";

export const stubGitHub = (target: Page | BrowserContext) =>
  target.route("https://api.github.com/**", (route) => route.fulfill({ json: { stargazers_count: 2 } }));

/** Opens a page that serves the star count itself. */
export const openPage = async (browser: Browser, options: BrowserContextOptions = {}): Promise<Page> => {
  const page = await browser.newPage(options);
  await stubGitHub(page);
  return page;
};

/** Resolves when Vue has mounted the app of the page. */
export const waitForHydration = (page: Page) => page.waitForFunction(() => Reflect.get(document.getElementById("app") ?? {}, "__vue_app__") !== undefined);
