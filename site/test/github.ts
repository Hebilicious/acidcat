import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright";

export const stubGitHub = (target: Page | BrowserContext) =>
  target.route("https://api.github.com/**", (route) => route.fulfill({ json: { stargazers_count: 2 } }));

/**
 * Opens a page that serves the star count itself and reports the browser online. Chromium reports the network of the
 * host in `navigator.onLine`, and VitePress fetches no page ahead when the browser is offline.
 */
export const openPage = async (browser: Browser, options: BrowserContextOptions = {}): Promise<Page> => {
  const page = await browser.newPage(options);
  await stubGitHub(page);
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "onLine", { get: () => true }));
  return page;
};
