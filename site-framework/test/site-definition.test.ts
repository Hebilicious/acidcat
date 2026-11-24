import assert from "node:assert/strict";
import { test } from "node:test";
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
