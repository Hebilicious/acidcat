/**
 * The functions that need Node.js. The main entry point, `@acid-cat/core-ts`, works in all runtimes.
 *
 * `serve` serves the web handlers of `mcpHandler` and `httpHandler` on Node.js, with only `node:http`.
 */
export { serve } from "@acid-cat/spec-ts/node";
export type { Routes, Served, ServeOptions, WebHandler } from "@acid-cat/spec-ts/node";
