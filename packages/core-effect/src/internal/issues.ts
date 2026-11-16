import { SchemaIssue } from "effect";

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

export const describe = (issue: SchemaIssue.Issue): string =>
  formatIssues(issue)
    .issues.map((each) => `${pathText(each.path) || "input"}: ${each.message}`)
    .join("; ");

const pathText = (path: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined): string =>
  (path ?? []).map((segment) => String(typeof segment === "object" ? segment.key : segment)).join(".");
