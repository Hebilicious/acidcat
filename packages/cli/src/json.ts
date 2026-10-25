/**
 * Checks of JSON values at run time. A value from a file, a process or a network is not trusted. These checks give it a
 * type only after they examine it.
 */
import type { JsonObject } from "@acid-cat/spec-ts";

export type { JsonObject };

/** True if the value is a JSON object: not `null`, and not an array. */
export const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** True if the value is an array of strings. */
export const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** True if the value is a JSON object, and `isMember` is true for each of its member values. */
export const isRecordOf = <T>(value: unknown, isMember: (member: unknown) => member is T): value is { readonly [key: string]: T } =>
  isObject(value) && Object.values(value).every(isMember);

/** The member `key` of a value, or `undefined` when the value is not an object. */
export const memberOf = (value: unknown, key: string): unknown => (isObject(value) ? value[key] : undefined);

/** Parse JSON text. The value is not trusted, so its type is `unknown`. */
export function parseJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  return value;
}

/** Read the body of a response as JSON. The value is not trusted, so its type is `unknown`. */
export async function readJson(response: Response): Promise<unknown> {
  const value: unknown = await response.json();
  return value;
}

/** True if the value is an array, and `isItem` is true for each of its items. */
export const isArrayOf = <T>(value: unknown, isItem: (item: unknown) => item is T): value is readonly T[] =>
  Array.isArray(value) && value.every(isItem);
