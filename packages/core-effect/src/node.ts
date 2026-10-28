/**
 * The modules that need Node.js. The main entry point, `@acid-cat/core-effect`, works in all runtimes.
 *
 * `NodeCli` needs `@effect/platform-node`. `NodeServer` needs only Node.js. Import it from
 * `@acid-cat/core-effect/NodeServer` to serve without `@effect/platform-node`.
 */
export * as NodeCli from "./NodeCli.ts";
export * as NodeServer from "./NodeServer.ts";
