import assert from "node:assert/strict";
import { test } from "node:test";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";
import { defineLazyLayout } from "../src/client/lazy-layout.ts";
import { isComponent, isVaporComponent, readSite } from "../src/client/site.ts";

test("a component is a function, or an object whose setup or render is a function", () => {
  for (const check of [isVaporComponent, isComponent]) {
    assert.equal(check(() => null), true);
    assert.equal(check({ setup: () => null }), true);
    assert.equal(check({ render: () => null }), true);
    assert.equal(check({ render: 1 }), false);
    assert.equal(check({ setup: () => null, render: "no" }), false);
    assert.equal(check({ name: "Layout" }), false);
    assert.equal(check(null), false);
  }
});

test("the layout of a site must be a component", () => {
  assert.throws(() => readSite({ layout: { render: 1 } }), /defineSite/);
  assert.doesNotThrow(() => readSite({ layout: { setup: () => null } }));
});

test("a lazy layout is defined when its module loads, not in the setup of a component", async () => {
  const loader = () => Promise.resolve({ default: { setup: () => [] } });
  assert.doesNotThrow(() => defineLazyLayout(loader, () => false));
  const app = createSSRApp({ setup: () => defineLazyLayout(loader, () => false) });
  app.config.warnHandler = () => undefined;
  await assert.rejects(renderToString(app), /top level of a module/);
});
