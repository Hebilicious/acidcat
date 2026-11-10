import { SchemaIssue } from "effect";

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

/** The message of an input that does not decode: each issue, with its path. */
export const describe = (issue: SchemaIssue.Issue): string =>
  formatIssues(issue)
    .issues.map((each) => `${pathText(each.path) || "input"}: ${each.message}`)
    .join("; ");

/** The path of an issue, for example `light.brightness`. */
const pathText = (path: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined): string =>
  (path ?? []).map((segment) => String(typeof segment === "object" ? segment.key : segment)).join(".");
