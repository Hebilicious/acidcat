import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";

import { MCP_PROTOCOL_VERSION, MCP_SERVER_CARD_PATH } from "@acid-cat/spec-ts";

import { Checks } from "../src/conform/check.ts";
import { conform, serve } from "../src/conform/index.ts";
import type { Served } from "../src/conform/index.ts";
import { isObject } from "../src/json.ts";

test("checks that run at the same time keep the order in which they are defined", async () => {
  const checks = new Checks("cli", 1_000);
  await checks.concurrently((check) => {
    check("slow", "rule", () => pause(50));
    check("fails", "rule", () => {
      throw new Error("refused");
    });
    check("fast", "rule", () => undefined);
  });
  assert.deepEqual(
    checks.results.map(({ name, passed, detail }) => [name, passed, detail]),
    [
      ["slow", true, undefined],
      ["fails", false, "refused"],
      ["fast", true, undefined],
    ],
  );
});

test("the end of a check stops the work that it started, also when one part of it fails first", async () => {
  const checks = new Checks("cli", 60_000);
  let started: AbortSignal | undefined;
  await checks.run("fails", "rule", async (signal) => {
    started = signal;
    await Promise.all([pause(60_000, undefined, { signal }), Promise.reject(new Error("refused"))]);
  });
  assert.equal(started?.aborted, true);
  assert.deepEqual(
    checks.results.map(({ name, passed, detail }) => [name, passed, detail]),
    [["fails", false, "refused"]],
  );
});

test("when the signal of conform aborts, the check that runs stops, and no other check starts", async () => {
  const stop = new AbortController();
  const checks = new Checks("cli", 60_000, stop.signal);
  let later = false;
  await checks.run("runs", "rule", async (signal) => {
    stop.abort();
    assert.equal(signal.aborted, true, "the signal of the check aborts with the signal of conform");
    throw new Error("aborted");
  });
  await checks.run("later", "rule", () => {
    later = true;
  });
  assert.equal(later, false);
  assert.deepEqual(
    checks.results.map(({ name, passed, detail }) => [name, passed, detail]),
    [
      ["runs", false, "conform stopped during the check: aborted"],
      ["later", false, "conform stopped before the check"],
    ],
  );
});

test("when the signal aborts in the cleanup after the last check, conform rejects with its reason", async () => {
  const stop = new AbortController();
  const reason = new Error("the test ended");
  const install = () => () => stop.abort(reason);
  await assert.rejects(conform({ webmcp: install, deadline: 10, signal: stop.signal }), (error) => error === reason);
});

/** An MCP server that answers only server/discover, so that conform reaches each check of the MCP surface, which fails. */
async function discoverOnly(onRequest: (path: string) => void): Promise<Served> {
  return serve(async (request) => {
    onRequest(new URL(request.url).pathname);
    if (request.headers.get("Mcp-Method") !== "server/discover") return new Response(null, { status: 404 });
    const message: unknown = await request.json();
    const id = isObject(message) ? message.id : null;
    return Response.json({ jsonrpc: "2.0", id, result: { resultType: "complete", supportedVersions: [MCP_PROTOCOL_VERSION], capabilities: {} } });
  });
}

test("when the signal aborts during the request for the Server Card, conform rejects with its reason and starts no later surface", async (t) => {
  const stop = new AbortController();
  const reason = new Error("the test ended");
  const server = await discoverOnly((path) => {
    if (path.endsWith(MCP_SERVER_CARD_PATH)) stop.abort(reason);
  });
  t.after(() => server.close());
  let installed = false;
  const install = () => {
    installed = true;
  };
  await assert.rejects(conform({ mcp: `${server.url}/mcp`, webmcp: install, signal: stop.signal }), (error) => error === reason);
  assert.equal(installed, false);
});

test("with no signal, conform gives the report of its checks", async () => {
  const checks = await conform({ webmcp: () => () => undefined, deadline: 10 });
  assert.deepEqual(
    checks.map(({ surface, name }) => `${surface}: ${name}`),
    [
      "webmcp: each available capability of the target is a tool",
      "webmcp: a tool has the description and the bundled input schema of its capability",
      "webmcp: a value resolves as a result",
      "webmcp: a failure resolves as a result",
      "webmcp: a defect rejects with the kind internal",
      "webmcp: invalid input rejects with the kind invalid-input, as a TypeError",
      "webmcp: the signal of the host cancels a call, as an AbortError",
      "webmcp: a tool is removed while its capability is unavailable, and registered again after",
    ],
  );
});
