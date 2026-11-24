import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright";

export const stubGitHub = (target: Page | BrowserContext) =>
  target.route("https://api.github.com/**", (route) => route.fulfill({ json: { stargazers_count: 2 } }));

export const openPage = async (browser: Browser, options: BrowserContextOptions = {}): Promise<Page> => {
  const page = await browser.newPage(options);
  await stubGitHub(page);
  return page;
};
