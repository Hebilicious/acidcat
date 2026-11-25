import assert from "node:assert/strict";
import { test } from "node:test";

import { serve } from "../src/index.ts";
import { closeDuringResponse, idleConnection } from "../../../test-support/idle-connection.ts";

test("serve closes no idle connection and sends no Keep-Alive header, so a client never sends a request while the server closes the connection", async () => {
  const served = await serve(() => new Response("ok"));
  try {
    assert.deepEqual(await idleConnection(served.url), { idleTimeoutMs: undefined, keepAlive: null });
  } finally {
    await served.close();
  }
});

test("after close, serve closes each connection when its response is complete", async (t) => {
  await closeDuringResponse(t, serve);
});
