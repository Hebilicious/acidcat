import { parseAst } from "vite";

/** The flag of a Vapor template that has no dynamic part. */
const staticFlag = 2;

type AstNode = { readonly type: string; readonly start: number; readonly end: number } & Readonly<Record<string, unknown>>;

const isAstNode = (value: unknown): value is AstNode =>
  typeof value === "object" && value !== null && typeof Reflect.get(value, "type") === "string" && typeof Reflect.get(value, "start") === "number" && typeof Reflect.get(value, "end") === "number";

const nodeList = (value: unknown): AstNode[] => (Array.isArray(value) ? value.filter((item) => isAstNode(item)) : []);

const childrenOf = (node: AstNode): AstNode[] => Object.values(node).flatMap((value) => (isAstNode(value) ? [value] : nodeList(value)));

const isFunction = (node: AstNode): boolean => node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression" || node.type === "FunctionDeclaration";

const branching: ReadonlySet<string> = new Set([
  "IfStatement",
  "ConditionalExpression",
  "LogicalExpression",
  "SwitchStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "TryStatement",
  "ChainExpression",
]);

const nameOf = (node: unknown): string | undefined => (isAstNode(node) && node.type === "Identifier" && typeof node["name"] === "string" ? node["name"] : undefined);

interface StaticTemplate {
  readonly html: AstNode;
}

const staticTemplates = (program: AstNode): Map<string, StaticTemplate> => {
  const templates = new Map<string, StaticTemplate>();
  for (const statement of childrenOf(program)) {
    if (statement.type !== "VariableDeclaration") continue;
    for (const declarator of childrenOf(statement)) {
      const init = declarator["init"];
      const name = nameOf(declarator["id"]);
      if (name === undefined || !isAstNode(init) || init.type !== "CallExpression") continue;
      const callee = nameOf(init["callee"]);
      if (callee !== "template" && callee !== "_template") continue;
      const [html, flags] = nodeList(init["arguments"]);
      if (!isAstNode(html) || typeof html["value"] !== "string" || !isAstNode(flags) || typeof flags["value"] !== "number") continue;
      if ((flags["value"] & staticFlag) !== 0) templates.set(name, { html });
    }
  }
  return templates;
};

const alwaysRendered = (program: AstNode, templates: ReadonlyMap<string, StaticTemplate>): Set<string> => {
  const sure = new Set<string>();
  const unsure = new Set<string>();
  const visit = (node: AstNode, ancestors: readonly AstNode[]): void => {
    const name = node.type === "CallExpression" ? nameOf(node["callee"]) : undefined;
    if (name !== undefined && templates.has(name)) {
      const functions = ancestors.filter((ancestor) => isFunction(ancestor));
      const [body] = functions;
      const owner = body === undefined ? undefined : ancestors[ancestors.indexOf(body) - 1];
      const ownerKey = owner?.type === "Property" ? nameOf(owner["key"]) : undefined;
      const inBranch = ancestors.slice(body === undefined ? 0 : ancestors.indexOf(body)).some((ancestor) => branching.has(ancestor.type));
      if (functions.length === 1 && (ownerKey === "setup" || ownerKey === "render") && !inBranch) sure.add(name);
      else unsure.add(name);
    }
    for (const child of childrenOf(node)) visit(child, [...ancestors, node]);
  };
  visit(program, []);
  return new Set([...sure].filter((name) => !unsure.has(name)));
};

/** While it hydrates, Vapor takes a static template from the DOM when its HTML is empty, and keeps a copy for the next render. */
export const leanTemplates = (code: string): string => {
  const program: unknown = parseAst(code);
  if (!isAstNode(program)) return code;
  const templates = staticTemplates(program);
  const lean = [...alwaysRendered(program, templates)].map((name) => templates.get(name)?.html).filter((html) => html !== undefined);
  return lean
    .sort((a, b) => b.start - a.start)
    .reduce((result, html) => `${result.slice(0, html.start)}""${result.slice(html.end)}`, code);
};
