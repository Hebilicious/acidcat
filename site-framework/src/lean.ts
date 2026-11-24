/** The flag of a Vapor template that has no dynamic part. */
const staticFlag = 2;

const templateCall = /\b(_?template)\("((?:[^"\\]|\\.)*)", (\d+)(?=[,)])/g;

/**
 * Empties the HTML of each static template of a component that the Vapor compiler wrote. While it hydrates, Vapor
 * takes a static template from the DOM when its HTML is empty, so the lean copy of a page hydrates the same and
 * leaves the static HTML of the page out of its script.
 */
export const leanTemplates = (code: string): string =>
  code.replace(templateCall, (call, name: string, _html: string, flags: string) => (Number(flags) & staticFlag ? `${name}("", ${flags}` : call));
