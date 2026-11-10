/**
 * The modules that need Node.js. The main entry point, `@acid-cat/core-effect`, works in all runtimes.
 *
 * `NodeCli` and `NodeMcp` need `@effect/platform-node`. `NodeServer` and `NodeWebhook` need only Node.js. Import them
 * from `@acid-cat/core-effect/NodeServer` and `@acid-cat/core-effect/NodeWebhook` to serve without
 * `@effect/platform-node`.
 */
export * as NodeCli from "./NodeCli.ts";
export * as NodeServer from "./NodeServer.ts";
export * as NodeWebhook from "./NodeWebhook.ts";
export * as NodeMcp from "./NodeMcp.ts";
