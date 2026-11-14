import assert from "node:assert/strict";
import { test } from "node:test";

import { z } from "zod";

import { capabilitiesFor, createSession, defineApp, eventsFor, httpHandler, isRefusal, mcpHandler, ok, refuse } from "../src/index.ts";
import type { Refusal } from "../src/index.ts";
import { readJson, toJsonSchema } from "./fixture.ts";
import { sseReader } from "./sse.ts";

/** The services of one request: who calls. */
interface Services {
  readonly caller: string;
}

const capability = capabilitiesFor<Services>();
const event = eventsFor<Services>();

const Who = z.object({ caller: z.string(), target: z.string() });

const app = defineApp({
  description: "Tell who calls, and through which target.",
  targets: { app: { bindings: ["typescript"] }, api: { bindings: ["http"] }, mcp: { bindings: ["mcp"] } },
  capabilities: [
    capability({
      id: "caller.get",
      description: "Give the caller of the request and the target of the session.",
      audience: ["api", "mcp"],
      readOnly: true,
      output: Who,
      run: (_input, { context, target }) => ok({ caller: context.caller, target }),
    }),
  ],
  events: [
    event({
      id: "caller.greeted",
      description: "Give one occurrence with the caller and the target of the session, then end.",
      audience: ["app", "api"],
      payload: Who,
      async *subscribe(_input, { context, target }) {
        yield { data: { caller: context.caller, target } };
      },
    }),
  ],
});

/** A `createContext` that reads the caller from `Authorization: Bearer <name>`, and counts the contexts that it makes and releases. */
function bearerContexts() {
  const counts = { created: 0, released: 0 };
  const createContext = (request: Request): (Services & AsyncDisposable) | Refusal => {
    const caller = /^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "")?.[1];
    if (caller === undefined) return refuse(401, "Give a valid token.", { "WWW-Authenticate": "Bearer" });
    counts.created += 1;
    return { caller, [Symbol.asyncDispose]: async () => void (counts.released += 1) };
  };
  return { counts, createContext };
}

/** Wait until a condition is true, or fail after one second. */
async function until(condition: () => boolean): Promise<void> {
  const end = Date.now() + 1000;
  while (!condition()) {
    if (Date.now() > end) throw new Error("The condition did not become true.");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const Message = z.object({ message: z.string() }).strict();

test("refuse gives a refusal, and isRefusal tells it from a context", () => {
  const refusal = refuse(403, "No.");
  assert.equal(isRefusal(refusal), true);
  assert.equal(refusal.status, 403);
  assert.equal(refusal.message, "No.");
  assert.equal(isRefusal({ status: 403, message: "No.", headers: new Headers() }), false);
  assert.equal(isRefusal(null), false);
});

test("through HTTP, a capability reads the caller from the context of the request and the target from the call", async () => {
  const { counts, createContext } = bearerContexts();
  const handler = httpHandler(app, { allowedOrigins: [], toJsonSchema, createContext });
  const call = (headers: Record<string, string>) =>
    handler(new Request("https://who.example/capabilities/caller.get", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: "{}" }));

  const answer = await call({ Authorization: "Bearer ada" });
  assert.equal(answer.status, 200);
  assert.deepEqual(await readJson(answer, z.object({ ok: z.literal(true), value: Who })), { ok: true, value: { caller: "ada", target: "api" } });
  assert.deepEqual(counts, { created: 1, released: 1 });

  const refused = await call({});
  assert.equal(refused.status, 401);
  assert.equal(refused.headers.get("WWW-Authenticate"), "Bearer");
  assert.equal(refused.headers.get("Content-Type"), "application/json");
  assert.deepEqual(await readJson(refused, Message), { message: "Give a valid token." });
  assert.deepEqual(counts, { created: 1, released: 1 });
});

test("through HTTP, the provider of an event reads the caller and the target, and the stream releases the context when it ends", async () => {
  const { counts, createContext } = bearerContexts();
  const handler = httpHandler(app, { allowedOrigins: [], toJsonSchema, createContext });
  const subscribe = (headers: Record<string, string>) =>
    handler(new Request("https://who.example/events/caller.greeted", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: "{}" }));

  const stream = await subscribe({ Authorization: "Bearer grace" });
  assert.equal(stream.status, 200);
  const reader = sseReader(stream);
  const first = await reader.next();
  assert.equal(first?.event, "next");
  assert.deepEqual(z.object({ data: Who }).parse(JSON.parse(first?.data ?? "")).data, { caller: "grace", target: "api" });
  assert.equal((await reader.next())?.event, "complete");
  assert.equal(await reader.next(), undefined);
  // The stream releases the context after its last chunk.
  await until(() => counts.released === 1);
  assert.deepEqual(counts, { created: 1, released: 1 });

  const refused = await subscribe({});
  assert.equal(refused.status, 401);
  assert.deepEqual(await readJson(refused, Message), { message: "Give a valid token." });
  assert.deepEqual(counts, { created: 1, released: 1 });
});

test("through MCP, a tool reads the caller from the context of the request and the target from the call", async () => {
  const { counts, createContext } = bearerContexts();
  const handler = mcpHandler(app, { name: "who", version: "0.0.0", allowedOrigins: [], toJsonSchema, createContext });
  const call = (headers: Record<string, string>) =>
    handler(
      new Request("https://who.example/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", "mcp-method": "tools/call", "mcp-protocol-version": "2026-07-28", ...headers },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "caller.get", arguments: {}, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
        }),
      }),
    );

  const answer = await call({ Authorization: "Bearer ada" });
  assert.equal(answer.status, 200);
  const { result } = await readJson(answer, z.object({ result: z.object({ structuredContent: Who }) }));
  assert.deepEqual(result.structuredContent, { caller: "ada", target: "mcp" });
  assert.deepEqual(counts, { created: 1, released: 1 });

  const refused = await call({});
  assert.equal(refused.status, 401);
  assert.equal(refused.headers.get("WWW-Authenticate"), "Bearer");
  assert.equal(refused.headers.get("Content-Type"), "application/json");
  assert.deepEqual(await readJson(refused, Message), { message: "Give a valid token." });
  assert.deepEqual(counts, { created: 1, released: 1 });
});

test("the provider of an event receives the target of the session", async () => {
  await using session = createSession(app, { target: "app", context: { caller: "local" }, toJsonSchema });
  const occurrences = await session.subscribe("caller.greeted", {});
  assert.ok(!("kind" in occurrences));
  const step = await occurrences.next();
  assert.ok(step.done !== true);
  assert.deepEqual(step.value.data, { caller: "local", target: "app" });
});
