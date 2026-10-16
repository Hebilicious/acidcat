import assert from "node:assert/strict";
import { test } from "node:test";

import { createSession, httpHandler } from "../src/index.ts";
import type { ToJsonSchema } from "../src/index.ts";
import { fixture, options, toJsonSchema } from "./fixture.ts";

/** A `toJsonSchema` that counts the schemas it writes. */
function countedToJsonSchema() {
  const counts = { writes: 0 };
  const counted: ToJsonSchema = (schema) => {
    counts.writes += 1;
    return toJsonSchema(schema);
  };
  return { counts, toJsonSchema: counted };
}

test("a session and its handles open without writing JSON Schema, and the view is written one time for each application", async () => {
  const { counts, toJsonSchema } = countedToJsonSchema();
  const session = createSession(fixture, { target: "app", ...options(), toJsonSchema });
  assert.equal(session.handles.get("fixture.echo")?.description, "Return the input text.");
  assert.deepEqual(await session.invoke("fixture.echo", { text: "hi" }), { ok: true, value: { text: "hi" } });
  assert.equal(counts.writes, 0);

  assert.ok("fixture.echo" in session.view.capabilities);
  const written = counts.writes;
  assert.ok(written > 0);
  assert.equal(session.view, session.view);

  const other = createSession(fixture, { target: "mcp", ...options(), toJsonSchema });
  assert.ok("fixture.echo" in other.view.capabilities);
  assert.equal(counts.writes, written);
  await Promise.all([session.dispose(), other.dispose()]);
});

test("an HTTP call writes no JSON Schema, and GET /catalog writes the view", async () => {
  const { counts, toJsonSchema } = countedToJsonSchema();
  const handler = httpHandler(fixture, { allowedOrigins: [], ...options(), toJsonSchema });
  const call = await handler(
    new Request("https://fixture.example/capabilities/fixture.echo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    }),
  );
  assert.equal(call.status, 200);
  assert.equal((await handler(new Request("https://fixture.example/capabilities"))).status, 200);
  assert.equal(counts.writes, 0);

  const catalog = async () => (await (await handler(new Request("https://fixture.example/catalog"))).json()) as { capabilities: object };
  assert.ok("fixture.echo" in (await catalog()).capabilities);
  const written = counts.writes;
  assert.ok(written > 0);
  assert.ok("fixture.echo" in (await catalog()).capabilities);
  assert.equal(counts.writes, written);
});
