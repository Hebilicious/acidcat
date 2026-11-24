import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { Browser, Page } from "playwright";
import { openPage } from "./github.ts";

// The rules of axe-core that the Lighthouse audit "Accessibility tree is well-formed" checks.
export const agentRules = [
  "button-name",
  "input-button-name",
  "input-image-alt",
  "label",
  "link-name",
  "select-name",
  "document-title",
  "aria-allowed-attr",
  "aria-allowed-role",
  "aria-command-name",
  "aria-conditional-attr",
  "aria-dialog-name",
  "aria-hidden-body",
  "aria-hidden-focus",
  "aria-input-field-name",
  "aria-prohibited-attr",
  "aria-required-attr",
  "aria-required-children",
  "aria-required-parent",
  "aria-roles",
  "aria-text",
  "aria-toggle-field-name",
  "aria-tooltip-name",
  "aria-treeitem-name",
  "aria-valid-attr",
  "aria-valid-attr-value",
  "duplicate-id-aria",
  "definition-list",
  "table-duplicate-name",
  "tabindex",
  "autocomplete-valid",
  "presentation-role-conflict",
  "svg-img-alt",
];

const axeSource = readFile(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

/** Runs axe-core in the page, and gives each violation with the elements that break it. */
export const axeViolations = async (page: Page, rules: readonly string[] | "every rule"): Promise<unknown> => {
  await page.addScriptTag({ content: await axeSource });
  const values = rules === "every rule" ? "axe.getRules().map((rule) => rule.ruleId)" : JSON.stringify(rules);
  return page.evaluate(
    `axe.run(document, { runOnly: { type: "rule", values: ${values} } }).then((result) => result.violations.map((violation) => violation.id + ": " + violation.nodes.map((node) => node.target.join(" ")).join(", ")))`,
  );
};

/** With its scripts blocked, each page with tabs or a code explorer has its roles in its HTML, and passes the rules that agents rely on. */
export const checkRolesWithScriptsBlocked = async (browser: Browser, origin: string): Promise<void> => {
  for (const [path, roles] of [
    ["/docs/quick-start/", ["tablist", "tab", "tabpanel"]],
    ["/examples/core-ts/", ["tree", "group", "treeitem"]],
  ] as const) {
    const page = await openPage(browser, { viewport: { width: 400, height: 860 } });
    await page.route(`${origin}/assets/**/*.js`, (route) => route.abort());
    await page.goto(`${origin}${path}`, { waitUntil: "load" });
    for (const role of roles) assert.ok((await page.locator(`[role="${role}"]`).count()) > 0, `${path} has the role ${role} in its HTML`);
    const violations = await axeViolations(page, agentRules);
    await page.close();
    assert.deepEqual(violations, [], path);
  }
};
