import assert from "node:assert/strict";
import { test } from "node:test";

import { serve } from "../src/index.ts";
import { checkClose, idleConnection } from "../../../test-support/idle-connection.ts";

test("serve closes no idle connection and sends no Keep-Alive header, so a client never sends a request while the server closes the connection", async () => {
  const served = await serve(() => new Response("ok"));
  try {
    assert.deepEqual(await idleConnection(served.url), { idleTimeoutMs: undefined, keepAlive: null });
  } finally {
    await served.close();
  }
});

test("close of serve resolves when each connection has ended, and cuts no request that the server accepted", async (t) => {
  await checkClose(t, serve);
});
