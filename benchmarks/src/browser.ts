import type { Browser, BrowserContext, Page } from "playwright";
import type { Target } from "./targets.ts";

/** The throttling of Lighthouse on mobile, applied with DevTools: a 4× slower CPU, and a slow 4G network. */
const throttling = { latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8, cpu: 4 } as const;

/** A desktop window, so that each framework shows its sidebar and its search button. */
const viewport = { width: 1350, height: 940 } as const;

export type Navigation = "same document" | "new document" | "back/forward cache";

export type InteractionMetrics = {
  readonly tabResponds: number | undefined;
  readonly searchResponds: number | undefined;
  readonly tabSwitch: number | undefined;
  readonly searchOpen: number | undefined;
  readonly changeCold: number | undefined;
  readonly changePrefetched: number | undefined;
  readonly back: number | undefined;
  readonly changeNavigation: Navigation | undefined;
  readonly backNavigation: Navigation | undefined;
};

/** From the start of the navigation, the probe clicks `click` every 50 ms until `done` matches a visible element. */
interface Repeat {
  readonly click: string;
  readonly done: string;
  /** `click`: the time of the click after which `done` matched. `paint`: the time of the first paint that shows `done`. */
  readonly time: "click" | "paint";
  readonly key: string;
}

interface ProbeConfig {
  readonly repeat: Repeat | undefined;
}

/**
 * Runs in each document before its own scripts. It records the time of each real pointer press, and it watches for
 * the element that a measure waits for. Both go to sessionStorage, which lives on through a page change that loads a
 * new document. With `repeat`, it clicks an element every 50 ms until another element shows: a tab until it is selected,
 * or the search button until the search field shows. The probe sends the events of a real click, and keeps a link from
 * following its `href` while no script does.
 */
const probe = (config: ProbeConfig): void => {
  const now = (): number => performance.timeOrigin + performance.now();
  const store = (key: string, value: number | string): void => sessionStorage.setItem(key, String(value));
  addEventListener("pointerdown", (event) => event.isTrusted && store("bench:input", performance.timeOrigin + event.timeStamp), true);
  addEventListener("pageshow", (event) => event.persisted && store("bench:restored", "1"));
  const afterPaint = (callback: () => void): void => {
    requestAnimationFrame(() => {
      const channel = new MessageChannel();
      channel.port1.onmessage = callback;
      channel.port2.postMessage(undefined);
    });
  };
  const visible = (selector: string, text: string | undefined): boolean =>
    [...document.querySelectorAll(selector)].some((element) => (text === undefined || (element.textContent ?? "").includes(text)) && element.checkVisibility());
  const watch = (): void => {
    const raw = sessionStorage.getItem("bench:expect");
    if (raw === null) return;
    const expected: unknown = JSON.parse(raw);
    if (typeof expected !== "object" || expected === null || !("id" in expected) || !("selector" in expected) || typeof expected.id !== "string" || typeof expected.selector !== "string") return;
    const key = `bench:done:${expected.id}`;
    if (sessionStorage.getItem(key) !== null) return;
    const text = "text" in expected && typeof expected.text === "string" ? expected.text : undefined;
    if (visible(expected.selector, text)) afterPaint(() => sessionStorage.getItem(key) === null && store(key, now()));
    else requestAnimationFrame(watch);
  };
  addEventListener("bench:watch", watch);
  addEventListener("pageshow", watch);
  watch();

  const { repeat } = config;
  if (repeat === undefined) return;
  addEventListener("click", (event) => {
    if (event instanceof MouseEvent && event.detail === -1 && event.target instanceof Element && event.target.closest("a") !== null) event.preventDefault();
  });
  let lastClick = 0;
  const tick = (): void => {
    if (lastClick > 0 && visible(repeat.done, undefined)) {
      if (repeat.time === "click") store(repeat.key, lastClick);
      else afterPaint(() => store(repeat.key, performance.now()));
      return;
    }
    const tab = document.querySelector(repeat.click);
    if (tab !== null) {
      lastClick = performance.now();
      const options = { bubbles: true, cancelable: true, composed: true, button: 0, detail: -1, view: window };
      tab.dispatchEvent(new PointerEvent("pointerdown", { ...options, isPrimary: true, pointerType: "mouse" }));
      tab.dispatchEvent(new MouseEvent("mousedown", options));
      tab.dispatchEvent(new PointerEvent("pointerup", { ...options, isPrimary: true, pointerType: "mouse" }));
      tab.dispatchEvent(new MouseEvent("mouseup", options));
      tab.dispatchEvent(new MouseEvent("click", options));
    }
    setTimeout(tick, 50);
  };
  tick();
};

/** A call that starts a navigation can lose its document before it returns. */
const ignoreNavigation = (error: unknown): void => {
  if (!(error instanceof Error && error.message.includes("Execution context was destroyed"))) throw error;
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Reads a key of sessionStorage, across page changes that replace the document, until it has a value. */
const waitForKey = async (page: Page, key: string, timeout = 30_000): Promise<number | undefined> => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await page.evaluate((name) => sessionStorage.getItem(name), key).catch(() => null);
    if (value !== null) return Number(value);
    await delay(100);
  }
  return undefined;
};

const open = async (browser: Browser, config: ProbeConfig): Promise<{ readonly context: BrowserContext; readonly page: Page }> => {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(probe, config);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: throttling.latency,
    downloadThroughput: throttling.downloadThroughput,
    uploadThroughput: throttling.uploadThroughput,
  });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttling.cpu });
  return { context, page };
};

let expectation = 0;

/** Asks the probe to watch for `selector` (with `text`), and returns the key where it writes the time of the first paint that shows it. */
const expect = async (page: Page, selector: string, text?: string): Promise<string> => {
  expectation += 1;
  const id = String(expectation);
  await page.evaluate((value) => {
    sessionStorage.setItem("bench:expect", value);
    dispatchEvent(new Event("bench:watch"));
  }, JSON.stringify({ id, selector, text }));
  return `bench:done:${id}`;
};

const documentToken = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const token = Math.random();
    Object.defineProperty(window, "__benchDocument", { value: token, configurable: true });
    return token;
  });

const navigationOf = async (page: Page, token: number): Promise<Navigation> => {
  const same = await page.evaluate((expected) => Reflect.get(window, "__benchDocument") === expected, token);
  if (same) return "same document";
  return (await page.evaluate(() => sessionStorage.getItem("bench:restored"))) === "1" ? "back/forward cache" : "new document";
};

const elapsed = async (page: Page, doneKey: string, startKey: string): Promise<number | undefined> => {
  const done = await waitForKey(page, doneKey);
  const start = await waitForKey(page, startKey, 1000);
  return done === undefined || start === undefined ? undefined : done - start;
};

const clickAndMeasure = async (page: Page, click: string, selector: string, text?: string): Promise<number | undefined> => {
  await page.evaluate(() => sessionStorage.removeItem("bench:input"));
  const done = await expect(page, selector, text);
  await page.locator(click).first().click();
  return elapsed(page, done, "bench:input");
};

/** From the start of the navigation, a click on the search button every 50 ms, until the first paint with the search field. The button needs the scripts of the framework in each app. */
const searchResponds = async (browser: Browser, origin: string, target: Target): Promise<number | undefined> => {
  if (target.search === undefined) return undefined;
  const { context, page } = await open(browser, { repeat: { click: target.search.button, done: target.search.input, time: "paint", key: "bench:search-responds" } });
  try {
    await page.goto(`${origin}${target.search.path}`);
    return await waitForKey(page, "bench:search-responds");
  } finally {
    await context.close();
  }
};

const firstVisit = async (browser: Browser, origin: string, target: Target): Promise<Pick<InteractionMetrics, "tabResponds" | "tabSwitch" | "searchOpen">> => {
  const { context, page } = await open(browser, { repeat: { click: target.tabs.tab(2), done: target.tabs.selected(2), time: "click", key: "bench:tab-responds" } });
  try {
    await page.goto(`${origin}${target.tabs.path}`);
    const tabResponds = await waitForKey(page, "bench:tab-responds");
    await page.waitForLoadState("load");
    await delay(2000);
    const tabSwitch = await clickAndMeasure(page, target.tabs.tab(3), target.tabs.selected(3));
    let searchOpen: number | undefined;
    if (target.search !== undefined) {
      if (target.search.path !== target.tabs.path) {
        await page.goto(`${origin}${target.search.path}`);
        await delay(2000);
      }
      searchOpen = await clickAndMeasure(page, target.search.button, target.search.input);
    }
    return { tabResponds, tabSwitch, searchOpen };
  } finally {
    await context.close();
  }
};

/**
 * A click on a sidebar link, from the press to the first paint of the new page. Cold: the click comes as soon as the
 * page has loaded, so only what the framework loaded by then helps. Prefetched: the pointer rests on the link, and the
 * click comes 2 s later. After the prefetched change, Back, from the call to the first paint of the first page.
 */
const pageChange = async (browser: Browser, origin: string, target: Target, prefetched: boolean): Promise<{ readonly change: number | undefined; readonly navigation: Navigation; readonly back?: number | undefined; readonly backNavigation?: Navigation }> => {
  const { context, page } = await open(browser, { repeat: undefined });
  try {
    await page.goto(`${origin}${target.change.from}`, { waitUntil: "load" });
    const link = page.locator(target.change.link).first();
    if (prefetched) {
      await link.hover();
      await delay(2000);
    }
    const token = await documentToken(page);
    const change = await clickAndMeasure(page, target.change.link, "h1", target.change.title);
    const navigation = await navigationOf(page, token);
    if (!prefetched) return { change, navigation };
    await delay(1000);
    const backToken = await documentToken(page);
    const done = await expect(page, "h1", target.change.backTitle);
    await page
      .evaluate(() => {
        sessionStorage.setItem("bench:back", String(performance.timeOrigin + performance.now()));
        history.back();
      })
      .catch(ignoreNavigation);
    const back = await elapsed(page, done, "bench:back");
    return { change, navigation, back, backNavigation: await navigationOf(page, backToken) };
  } finally {
    await context.close();
  }
};

export const measureInteractions = async (browser: Browser, origin: string, target: Target): Promise<InteractionMetrics> => {
  const visit = await firstVisit(browser, origin, target);
  const search = await searchResponds(browser, origin, target);
  const cold = await pageChange(browser, origin, target, false);
  const warm = await pageChange(browser, origin, target, true);
  return {
    ...visit,
    searchResponds: search,
    changeCold: cold.change,
    changePrefetched: warm.change,
    back: warm.back,
    changeNavigation: warm.navigation,
    backNavigation: warm.backNavigation,
  };
};
