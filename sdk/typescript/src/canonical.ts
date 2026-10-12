/**
 * The canonical form of a catalog (spec/catalog.md#canonical-form): the one way to write a catalog as text, so that
 * every tool and every SDK produces the same bytes for the same catalog.
 */

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
type JsonObject = { readonly [key: string]: Json };

const CATALOG_ORDER = ["acidcat", "title", "description", "targets", "$defs", "capabilities"];
const TARGET_ORDER = ["bindings", "description", "options"];
const CAPABILITY_ORDER = ["description", "audience", "input", "output", "failures", "readOnly", "state"];

/** A catalog in canonical form, as text. */
export function canonicalText(catalog: unknown): string {
  return `${write(canonicalCatalog(catalog as JsonObject), "")}\n`;
}

/** Put a catalog's members in canonical order. */
export function canonicalCatalog(catalog: JsonObject): JsonObject {
  return ordered(catalog, CATALOG_ORDER, (key, value) => {
    if (key === "targets") return byKey(value, (target) => ordered(target as JsonObject, TARGET_ORDER, sortedMember));
    if (key === "$defs") return byKey(value, sorted);
    if (key === "capabilities") {
      return byKey(value, (capability) =>
        ordered(capability as JsonObject, CAPABILITY_ORDER, (member, inner) =>
          member === "failures" ? byKey(inner, sorted) : sortedMember(member, inner),
        ),
      );
    }
    return sortedMember(key, value);
  });
}

/** The known members in their order, then every other member sorted by key. */
function ordered(value: JsonObject, order: readonly string[], each: (key: string, value: Json) => Json): JsonObject {
  const known = order.filter((key) => key in value);
  const others = Object.keys(value)
    .filter((key) => !order.includes(key))
    .sort(byCodePoint);
  return Object.fromEntries([...known, ...others].map((key) => [key, each(key, value[key]!)]));
}

/** A map keyed by name or id: its keys sorted, each value shaped by `each`. */
function byKey(value: Json, each: (inner: Json) => Json): Json {
  const object = value as JsonObject;
  return Object.fromEntries(
    Object.keys(object)
      .sort(byCodePoint)
      .map((key) => [key, each(object[key]!)]),
  );
}

function sortedMember(_key: string, value: Json): Json {
  return sorted(value);
}

/** Every object's keys sorted, at every depth. Arrays keep their order. */
function sorted(value: Json): Json {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object") return byKey(value, sorted);
  return value;
}

/** Order strings by Unicode code point, as Python, Go and Rust compare them. */
export function byCodePoint(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const difference = a[i]!.codePointAt(0)! - b[i]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

/** Write a JSON value with two-space indentation, one member or item per line. */
function write(value: Json, indent: string): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const inner = `${indent}  `;
    return `[\n${value.map((item) => inner + write(item, inner)).join(",\n")}\n${indent}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return "{}";
    const inner = `${indent}  `;
    const members = keys.map((key) => `${inner}${JSON.stringify(key)}: ${write((value as JsonObject)[key]!, inner)}`);
    return `{\n${members.join(",\n")}\n${indent}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("A catalog holds only finite numbers");
  return JSON.stringify(value);
}
