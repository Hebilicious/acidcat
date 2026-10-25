/**
 * The canonical form of a catalog (spec/catalog.md#canonical-form): the one way to write a catalog as text, so that
 * every tool and every catalog library produces the same bytes for the same catalog.
 */

/** A JSON object, or any other object read by its keys. */
type JsonObject = { readonly [key: string]: unknown };

const isObject = (value: unknown): value is JsonObject => value !== null && typeof value === "object";

const CATALOG_ORDER = ["acidcat", "title", "description", "targets", "$defs", "capabilities"];
const TARGET_ORDER = ["bindings", "description", "options"];
const CAPABILITY_ORDER = ["description", "audience", "input", "output", "failures", "readOnly", "state"];

/** A catalog in canonical form, as text. */
export function canonicalText(catalog: unknown): string {
  return `${write(canonicalCatalog(catalog), "")}\n`;
}

/** Put a catalog's members in canonical order. */
export function canonicalCatalog(catalog: unknown): unknown {
  return ordered(catalog, CATALOG_ORDER, (key, value) => {
    if (key === "targets") return byKey(value, (target) => ordered(target, TARGET_ORDER, sortedMember));
    if (key === "$defs") return byKey(value, sorted);
    if (key === "capabilities") {
      return byKey(value, (capability) =>
        ordered(capability, CAPABILITY_ORDER, (member, inner) => (member === "failures" ? byKey(inner, sorted) : sortedMember(member, inner))),
      );
    }
    return sortedMember(key, value);
  });
}

/** The known members in their order, then every other member sorted by key. A value that is not an object is sorted. */
function ordered(value: unknown, order: readonly string[], each: (key: string, value: unknown) => unknown): unknown {
  if (!isObject(value)) return sorted(value);
  const known = order.filter((key) => key in value);
  const others = Object.keys(value)
    .filter((key) => !order.includes(key))
    .sort(byCodePoint);
  return Object.fromEntries([...known, ...others].map((key) => [key, each(key, value[key])]));
}

/** A map keyed by name or id: its keys sorted, each value shaped by `each`. A value that is not an object is sorted. */
function byKey(value: unknown, each: (inner: unknown) => unknown): unknown {
  if (!isObject(value)) return sorted(value);
  return Object.fromEntries(
    Object.keys(value)
      .sort(byCodePoint)
      .map((key) => [key, each(value[key])]),
  );
}

function sortedMember(_key: string, value: unknown): unknown {
  return sorted(value);
}

/** Every object's keys sorted, at every depth. Arrays keep their order. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => sorted(item));
  if (isObject(value)) return byKey(value, sorted);
  return value;
}

/** Order strings by Unicode code point, as Python, Go and Rust compare them. */
export function byCodePoint(left: string, right: string): number {
  const a = Array.from(left, (character) => character.codePointAt(0));
  const b = Array.from(right, (character) => character.codePointAt(0));
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const [first, second] = [a[i], b[i]];
    if (first !== undefined && second !== undefined && first !== second) return first - second;
  }
  return a.length - b.length;
}

/** Write a JSON value with two-space indentation, one member or item per line. */
function write(value: unknown, indent: string): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const inner = `${indent}  `;
    return `[\n${value.map((item: unknown) => inner + write(item, inner)).join(",\n")}\n${indent}]`;
  }
  if (isObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return "{}";
    const inner = `${indent}  `;
    const members = keys.map((key) => `${inner}${JSON.stringify(key)}: ${write(value[key], inner)}`);
    return `{\n${members.join(",\n")}\n${indent}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("A catalog holds only finite numbers");
  return JSON.stringify(value);
}
