import type { JsonObject } from "@acid-cat/spec-ts";

export type { JsonObject };

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

export const isRecordOf = <T>(value: unknown, isMember: (member: unknown) => member is T): value is { readonly [key: string]: T } =>
  isObject(value) && Object.values(value).every(isMember);

export const memberOf = (value: unknown, key: string): unknown => (isObject(value) ? value[key] : undefined);

export function parseJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  return value;
}

export async function readJson(response: Response): Promise<unknown> {
  const value: unknown = await response.json();
  return value;
}

export const isArrayOf = <T>(value: unknown, isItem: (item: unknown) => item is T): value is readonly T[] =>
  Array.isArray(value) && value.every(isItem);
