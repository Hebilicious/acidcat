import { REFERENCE } from "@acid-cat/spec-ts";

import type { Catalog } from "./catalog.ts";
import { isObject, isStringArray } from "./json.ts";
import type { JsonObject } from "./json.ts";

export type TypeScriptTypes = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly errors: readonly string[] };

type Node =
  | { readonly kind: "name"; readonly text: string }
  | { readonly kind: "object"; readonly members: readonly Member[]; readonly index: Node | undefined }
  | { readonly kind: "array"; readonly item: Node }
  | { readonly kind: "tuple"; readonly elements: readonly { readonly type: Node; readonly optional: boolean }[]; readonly rest: Node | undefined }
  | { readonly kind: "union"; readonly members: readonly Node[] }
  | { readonly kind: "intersection"; readonly members: readonly Node[] };

interface Member {
  readonly key: string;
  readonly optional: boolean;
  readonly doc: string | undefined;
  readonly type: Node;
}

const HEADER = "// Written by `acid-cat types typescript`. Do not change this file by hand.";

const RESERVED = new Set(
  [
    "await break case catch class const continue debugger default delete do else enum export extends false finally for function if",
    "implements import in instanceof interface let new null package private protected public return static super switch this throw",
    "true try typeof var void while with yield any bigint boolean never number object string symbol undefined unknown",
  ].flatMap((line) => line.split(" ")),
);

const name = (text: string): Node => ({ kind: "name", text });
const UNKNOWN = name("unknown");
const NEVER = name("never");
const isName = (node: Node, text: string) => node.kind === "name" && node.text === text;
const EMPTY_OBJECT: Node = { kind: "object", members: [], index: undefined };

const isIdentifier = (text: string) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text);
const isTypeName = (text: string) => isIdentifier(text) && !RESERVED.has(text);
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sortedEntries = <T>(record: { readonly [key: string]: T }) => Object.entries(record).sort(([a], [b]) => byCodePoint(a, b));

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const prefixOf = (id: string) => id.split(/[.-]/).map(capitalized).join("");

function stableText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableText).join(",")}]`;
  if (isObject(value)) return `{${sortedEntries(value).map(([key, item]) => `${JSON.stringify(key)}:${stableText(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

const withoutTitle = ({ title: _title, ...rest }: JsonObject) => rest;

const descriptionOf = (schema: unknown) => (isObject(schema) && typeof schema.description === "string" ? schema.description : undefined);

function unionOf(nodes: readonly Node[]): Node {
  const members = nodes.flatMap((node) => (node.kind === "union" ? node.members : [node])).filter((node) => !isName(node, "never"));
  if (members.some((node) => isName(node, "unknown"))) return UNKNOWN;
  const unique = uniqueNodes(members);
  return unique.length === 0 ? NEVER : unique.length === 1 && unique[0] !== undefined ? unique[0] : { kind: "union", members: unique };
}

function intersectionOf(nodes: readonly Node[]): Node {
  const members = nodes.flatMap((node) => (node.kind === "intersection" ? node.members : [node])).filter((node) => !isName(node, "unknown"));
  if (members.some((node) => isName(node, "never"))) return NEVER;
  const unique = uniqueNodes(members);
  return unique.length === 0 ? UNKNOWN : unique.length === 1 && unique[0] !== undefined ? unique[0] : { kind: "intersection", members: unique };
}

function uniqueNodes(nodes: readonly Node[]): Node[] {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    const text = render(node, 0);
    if (seen.has(text)) return false;
    seen.add(text);
    return true;
  });
}

function literal(value: unknown): Node {
  if (Array.isArray(value)) return { kind: "tuple", elements: value.map((item) => ({ type: literal(item), optional: false })), rest: undefined };
  if (isObject(value)) {
    const members = Object.entries(value).map(([key, item]) => ({ key, optional: false, doc: undefined, type: literal(item) }));
    return { kind: "object", members, index: undefined };
  }
  return name(typeof value === "string" ? JSON.stringify(value) : String(value));
}

function jsonKindAccepted(value: unknown, kinds: ReadonlySet<string>): boolean {
  if (value === null) return kinds.has("null");
  if (Array.isArray(value)) return kinds.has("array");
  if (typeof value === "number") return kinds.has("number") || (kinds.has("integer") && Number.isInteger(value));
  return kinds.has(isObject(value) ? "object" : typeof value);
}

const docLines = (text: string, pad: string) => {
  const lines = text.replaceAll("*/", "*\\/").split(/\r?\n/);
  if (lines.length === 1) return `${pad}/** ${lines[0]} */\n`;
  return `${pad}/**\n${lines.map((line) => `${pad} *${line === "" ? "" : ` ${line}`}`.trimEnd()).join("\n")}\n${pad} */\n`;
};

const keyText = (key: string) => (isIdentifier(key) ? key : JSON.stringify(key));

const grouped = (node: Node, indent: number) => {
  const text = render(node, indent);
  return node.kind === "name" || node.kind === "object" ? text : `(${text})`;
};

const unionMember = (node: Node, indent: number) => (node.kind === "intersection" ? `(${render(node, indent)})` : render(node, indent));

function render(node: Node, indent: number): string {
  switch (node.kind) {
    case "name":
      return node.text;
    case "array":
      return `readonly ${grouped(node.item, indent)}[]`;
    case "tuple": {
      const elements = node.elements.map(({ type, optional }) => (optional ? `${grouped(type, indent)}?` : render(type, indent)));
      const rest = node.rest === undefined ? [] : [`...${grouped(node.rest, indent)}[]`];
      return `readonly [${[...elements, ...rest].join(", ")}]`;
    }
    case "union":
      return node.members.map((member) => unionMember(member, indent)).join(" | ");
    case "intersection":
      return node.members.map((member) => (member.kind === "union" ? `(${render(member, indent)})` : render(member, indent))).join(" & ");
    case "object":
      return renderObject(node.members, node.index, indent);
  }
}

function renderObject(members: readonly Member[], index: Node | undefined, indent: number): string {
  if (members.length === 0) return `{ readonly [key: string]: ${index === undefined ? "never" : render(index, indent)} }`;
  const inner = indent + 1;
  const lines = members.map(({ key, optional, type }) => `readonly ${keyText(key)}${optional ? "?" : ""}: ${render(type, inner)}`);
  if (index !== undefined) lines.push(`readonly [key: string]: ${render(index, inner)}`);
  const inline = `{ ${lines.join("; ")} }`;
  if (members.every((member) => member.doc === undefined) && !inline.includes("\n") && inline.length <= 80) return inline;
  const pad = "  ".repeat(inner);
  const body = lines.map((line, position) => {
    const doc = members[position]?.doc;
    return `${doc === undefined ? "" : docLines(doc, pad)}${pad}${line};\n`;
  });
  return `{\n${body.join("")}${"  ".repeat(indent)}}`;
}

const declaration = (typeName: string, doc: string | undefined, node: Node) =>
  `${doc === undefined ? "" : docLines(doc, "")}export type ${typeName} = ${render(node, 0)};`;

const interfaceDeclaration = (typeName: string, members: readonly Member[]) =>
  `export interface ${typeName} ${members.length === 0 ? "{}" : renderObject(members, undefined, 0)}`;

/**
 * Write the TypeScript types of a catalog (spec/bindings/typescript.md#handles): a type for each type in `$defs`, and
 * the input, value, failure and state of each capability, and the input and payload of each event, with the
 * `Capabilities` and `Events` interfaces that map each id to its types. The same catalog gives the same text.
 */
export function typescriptTypes(catalog: Catalog): TypeScriptTypes {
  const errors: string[] = [];
  const types = catalog.$defs ?? {};
  const names = new Map<string, { readonly origin: string; readonly key: string | undefined }>();
  let titled: string[] = [];

  const claim = (typeName: string, origin: string, key?: string) => {
    const existing = names.get(typeName);
    if (existing === undefined) names.set(typeName, { origin, key });
    else errors.push(`two types have the name ${typeName}: ${existing.origin} and ${origin}`);
  };

  const convert = (schema: unknown, where: string, emptyMeansNone = false): Node => {
    if (schema === true) return UNKNOWN;
    if (schema === false) return NEVER;
    if (!isObject(schema)) return UNKNOWN;
    if (typeof schema.title === "string") {
      const titledName = name(titledType(schema, schema.title, where));
      return emptyMeansNone && declaresNoProperties(schema) ? intersectionOf([titledName, EMPTY_OBJECT]) : titledName;
    }
    return structure(schema, where, emptyMeansNone, true);
  };

  const titledType = (schema: JsonObject, title: string, where: string): string => {
    if (!isTypeName(title)) {
      errors.push(`${where}: the title ${JSON.stringify(title)} is not a TypeScript name`);
      return title;
    }
    const key = stableText(withoutTitle(schema));
    const existing = names.get(title);
    if (existing !== undefined) {
      if (existing.key !== key) errors.push(`two types have the name ${title}: ${existing.origin} and the title in ${where}`);
      return title;
    }
    names.set(title, { origin: `the title in ${where}`, key });
    const node = structure(schema, where, false, true);
    titled.push(declaration(title, descriptionOf(schema), node));
    return title;
  };

  const structure = (schema: JsonObject, where: string, emptyMeansNone: boolean, titles: boolean): Node => {
    const sub = (child: unknown, place: string) => (titles ? convert(child, `${where} ${place}`) : withoutTitles(child, `${where} ${place}`));
    const not = schema.not;
    if (not === true || (isObject(not) && Object.keys(not).length === 0)) return NEVER;
    const kinds = typeof schema.type === "string" ? [schema.type] : isStringArray(schema.type) ? schema.type : undefined;
    const values = Object.hasOwn(schema, "const") ? [schema.const] : Array.isArray(schema.enum) ? schema.enum : undefined;
    if (values !== undefined) {
      const accepted = kinds === undefined ? values : values.filter((value) => jsonKindAccepted(value, new Set(kinds)));
      return unionOf(accepted.map(literal));
    }
    const parts: Node[] = [];
    const reference = typeof schema.$ref === "string" ? REFERENCE.exec(schema.$ref)?.[1] : undefined;
    if (reference !== undefined && Object.hasOwn(types, reference)) parts.push(name(reference));
    if (kinds !== undefined) {
      parts.push(
        unionOf(
          kinds.map((kind) => {
            if (kind === "string" || kind === "boolean" || kind === "null") return name(kind);
            if (kind === "number" || kind === "integer") return name("number");
            if (kind === "array") return arrayNode(schema, sub);
            if (kind === "object") return objectNode(schema, emptyMeansNone, sub);
            return UNKNOWN;
          }),
        ),
      );
    }
    for (const member of ["anyOf", "oneOf"]) {
      const schemas = schema[member];
      if (Array.isArray(schemas) && schemas.length > 0) parts.push(unionOf(schemas.map((item, position) => sub(item, `${member}[${position}]`))));
    }
    if (Array.isArray(schema.allOf)) parts.push(...schema.allOf.map((item, position) => sub(item, `allOf[${position}]`)));
    return intersectionOf(parts);
  };

  const withoutTitles = (schema: unknown, where: string): Node => {
    if (schema === true) return UNKNOWN;
    if (schema === false) return NEVER;
    return isObject(schema) ? structure(schema, where, false, false) : UNKNOWN;
  };

  for (const [typeName, schema] of sortedEntries(types)) {
    if (isTypeName(typeName)) claim(typeName, `type ${typeName} in $defs`, stableText(withoutTitle(schema)));
    else errors.push(`type ${typeName} in $defs: ${JSON.stringify(typeName)} is not a TypeScript name`);
  }
  const capabilities = sortedEntries(catalog.capabilities);
  const events = sortedEntries(catalog.events ?? {});
  for (const [id, capability] of capabilities) {
    const prefix = prefixOf(id);
    for (const member of ["input", "value", "failure", ...(capability.state === undefined ? [] : ["state"])]) {
      claim(`${prefix}${capitalized(member)}`, `the ${member} of capability ${id}`);
    }
  }
  for (const [id] of events) {
    claim(`${prefixOf(id)}Input`, `the input of event ${id}`);
    claim(`${prefixOf(id)}Payload`, `the payload of event ${id}`);
  }
  claim("Capabilities", "the interface of the capabilities");
  if (events.length > 0) claim("Events", "the interface of the events");
  if (errors.length > 0) return { ok: false, errors };

  const blocks = sortedEntries(types).map(([typeName, schema]) => declaration(typeName, descriptionOf(schema), withoutTitles(schema, `type ${typeName}`)));
  const aliasDoc = (schema: unknown) => (isObject(schema) && typeof schema.title !== "string" ? descriptionOf(schema) : undefined);
  const flush = (aliases: readonly string[]) => {
    blocks.push(...titled, ...aliases);
    titled = [];
  };

  const capabilityMembers: Member[] = [];
  for (const [id, capability] of capabilities) {
    const prefix = prefixOf(id);
    const input = capability.input === undefined ? EMPTY_OBJECT : convert(capability.input, `${id} input`, true);
    const value = capability.output === undefined ? name("null") : convert(capability.output, `${id} output`);
    const state = capability.state === undefined ? undefined : convert(capability.state, `${id} state`);
    const failures = sortedEntries(capability.failures ?? {}).map(([tag, schema]) => ({
      doc: aliasDoc(schema),
      node: taggedFailure(tag, convert(schema, `${id} failure ${tag}`)),
    }));
    flush([
      declaration(`${prefix}Input`, aliasDoc(capability.input), input),
      declaration(`${prefix}Value`, aliasDoc(capability.output), value),
      failureDeclaration(`${prefix}Failure`, failures),
      ...(state === undefined ? [] : [declaration(`${prefix}State`, aliasDoc(capability.state), state)]),
    ]);
    const members = ["input", "value", "failure", ...(state === undefined ? [] : ["state"])];
    capabilityMembers.push(entry(id, capability.description, members.map((member) => [member, `${prefix}${capitalized(member)}`])));
  }

  const eventMembers: Member[] = [];
  for (const [id, event] of events) {
    const prefix = prefixOf(id);
    const input = event.input === undefined ? EMPTY_OBJECT : convert(event.input, `${id} input`, true);
    const payload = event.payload === undefined ? EMPTY_OBJECT : convert(event.payload, `${id} payload`, true);
    flush([declaration(`${prefix}Input`, aliasDoc(event.input), input), declaration(`${prefix}Payload`, aliasDoc(event.payload), payload)]);
    eventMembers.push(entry(id, event.description, [["input", `${prefix}Input`], ["payload", `${prefix}Payload`]]));
  }

  if (errors.length > 0) return { ok: false, errors };
  blocks.push(interfaceDeclaration("Capabilities", capabilityMembers));
  if (events.length > 0) blocks.push(interfaceDeclaration("Events", eventMembers));
  return { ok: true, text: `${[HEADER, ...blocks].join("\n\n")}\n` };
}

function arrayNode(schema: JsonObject, sub: (child: unknown, place: string) => Node): Node {
  const items = schema.items;
  const itemNode = (place: string) => (items === undefined || items === true ? UNKNOWN : isObject(items) || items === false ? sub(items, place) : UNKNOWN);
  if (!Array.isArray(schema.prefixItems)) return items === false ? { kind: "tuple", elements: [], rest: undefined } : { kind: "array", item: itemNode("items") };
  const minimum = typeof schema.minItems === "number" ? schema.minItems : 0;
  const elements = schema.prefixItems.map((item, position) => ({ type: sub(item, `prefixItems[${position}]`), optional: position >= minimum }));
  const rest = itemNode("items");
  return { kind: "tuple", elements, rest: isName(rest, "never") ? undefined : rest };
}

function objectNode(schema: JsonObject, emptyMeansNone: boolean, sub: (child: unknown, place: string) => Node): Node {
  const properties = isObject(schema.properties) ? schema.properties : {};
  const required = isStringArray(schema.required) ? schema.required : [];
  const patterns = isObject(schema.patternProperties);
  const additional = emptyMeansNone && declaresNoProperties(schema) ? false : schema.additionalProperties;
  const members: Member[] = Object.entries(properties).map(([key, property]) => ({
    key,
    optional: !required.includes(key),
    doc: descriptionOf(property),
    type: sub(property, `property ${key}`),
  }));
  for (const key of new Set(required)) {
    if (!Object.hasOwn(properties, key)) members.push({ key, optional: false, doc: undefined, type: UNKNOWN });
  }
  const open = patterns || additional !== false;
  if (members.length > 0) return { kind: "object", members, index: open && members.every(({ optional }) => optional) ? UNKNOWN : undefined };
  if (patterns || additional === undefined || additional === true) return { kind: "object", members, index: UNKNOWN };
  const index = additional === false ? NEVER : sub(additional, "additionalProperties");
  return { kind: "object", members, index: isName(index, "never") ? undefined : index };
}

function declaresNoProperties(schema: JsonObject): boolean {
  const { properties } = schema;
  return isObject(properties) && Object.keys(properties).length === 0 && schema.additionalProperties === undefined && !isObject(schema.patternProperties);
}

function taggedFailure(tag: string, node: Node): Node {
  const member: Member = { key: "_tag", optional: false, doc: undefined, type: name(JSON.stringify(tag)) };
  if (node.kind === "object" && !node.members.some(({ key }) => key === "_tag") && (node.index === undefined || isName(node.index, "unknown"))) {
    return { kind: "object", members: [member, ...node.members], index: undefined };
  }
  return intersectionOf([{ kind: "object", members: [member], index: undefined }, node]);
}

function failureDeclaration(typeName: string, failures: readonly { readonly doc: string | undefined; readonly node: Node }[]): string {
  const [first] = failures;
  if (first === undefined) return declaration(typeName, undefined, NEVER);
  if (failures.length === 1) return declaration(typeName, first.doc, first.node);
  const members = failures.map(({ doc, node }) => `${doc === undefined ? "" : docLines(doc, "  ")}  | ${unionMember(node, 1)}`);
  return `export type ${typeName} =\n${members.join("\n")};`;
}

function entry(id: string, description: string, types: readonly (readonly [string, string])[]): Member {
  const members = types.map(([key, typeName]) => ({ key, optional: false, doc: undefined, type: name(typeName) }));
  return { key: id, optional: false, doc: description, type: { kind: "object", members, index: undefined } };
}
