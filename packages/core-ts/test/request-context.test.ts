import assert from "node:assert/strict";
import { test } from "node:test";

import { z } from "zod";

import { capabilitiesFor, createSession, defineApp, eventsFor, httpHandler, isRefusal, mcpHandler, ok, refuse } from "../src/index.ts";
import type { Refusal } from "../src/index.ts";
import { webhookDelivery } from "../src/node.ts";
import { readJson, toJsonSchema } from "./fixture.ts";
import { ManualClock } from "./manual-clock.ts";
import { sseReader } from "./sse.ts";
import { startReceiver, testCertificate } from "./webhook-receiver.ts";

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
    event({
      id: "caller.watched",
      description: "Give one occurrence with the caller and the target of the session, then wait until the subscription ends.",
      audience: ["mcp"],
      payload: Who,
      async *subscribe(_input, { context, target, signal }) {
        yield { data: { caller: context.caller, target } };
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
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

/** A request to the MCP server of the test, with the caller `Bearer <caller>`, the principal of the caller, and a JSON-RPC message. */
function mcpRequest(caller: string, method: string, params: object): Request {
  return new Request("https://who.example/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", "MCP-Protocol-Version": "2026-07-28", Authorization: `Bearer ${caller}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } }),
  });
}

const Poll = z.object({ result: z.object({ events: z.array(z.object({ data: Who })), cursor: z.string() }) });

test("through MCP, a poll lease uses the context of the request that started it, and releases it when the lease ends", async () => {
  const { counts, createContext } = bearerContexts();
  const clock = new ManualClock();
  await using handler = mcpHandler(app, { name: "who", version: "0.0.0", allowedOrigins: [], toJsonSchema, createContext, clock, poll: { leaseMs: 1000 } });

  const started = await readJson(await handler(mcpRequest("ada", "events/poll", { name: "caller.watched" })), Poll);
  // One context for the request. The lease holds it after the answer.
  assert.deepEqual(counts, { created: 1, released: 0 });

  // The session of the lease sees the caller of the request that started it. A poll with the same key reads the
  // same lease: its request has a context of its own, which the handler releases after the answer.
  const read = async () => (await readJson(await handler(mcpRequest("ada", "events/poll", { name: "caller.watched", cursor: started.result.cursor })), Poll)).result.events;
  let events = await read();
  while (events.length === 0) events = await read();
  assert.deepEqual(events.map((each) => each.data), [{ caller: "ada", target: "mcp" }]);
  assert.equal(counts.created - counts.released, 1);

  // The lease ends when it gets no poll for the lease time. Then the handler releases the context of the first request.
  clock.advance(1000);
  await until(() => counts.released === counts.created);
});

test("through MCP, a webhook subscription uses the context of the request that started it, and releases it when the subscription ends", async () => {
  const certificate = testCertificate();
  const receiver = await startReceiver(certificate);
  try {
    const { counts, createContext } = bearerContexts();
    const webhooks = webhookDelivery({ allowPrivateNetworks: true, ca: certificate.cert, retryDelayMs: () => 5 });
    await using handler = mcpHandler(app, {
      name: "who",
      version: "0.0.0",
      allowedOrigins: [],
      toJsonSchema,
      createContext,
      principal: (request) => request.headers.get("Authorization") ?? undefined,
      webhooks,
    });
    const delivery = { mode: "webhook", url: receiver.url, secret: `whsec_${Buffer.alloc(32, 7).toString("base64")}` };

    const subscribed = await handler(mcpRequest("grace", "events/subscribe", { name: "caller.watched", delivery }));
    assert.equal(subscribed.status, 200);
    await readJson(subscribed, z.object({ result: z.object({ id: z.string() }) }));
    // One context for the request. The subscription holds it after the answer.
    assert.deepEqual(counts, { created: 1, released: 0 });

    // The session of the subscription sees the caller of the request that started it.
    await until(() => receiver.received.some((each) => each.body["type"] !== "verification"));
    const delivered = receiver.received.find((each) => each.body["type"] !== "verification");
    assert.deepEqual(z.object({ data: Who }).parse(delivered?.body).data, { caller: "grace", target: "mcp" });
    assert.deepEqual(counts, { created: 1, released: 0 });

    // The end of the subscription releases the context of the first request.
    const ended = await handler(mcpRequest("grace", "events/unsubscribe", { name: "caller.watched", delivery: { url: receiver.url } }));
    assert.equal(ended.status, 200);
    await until(() => counts.released === counts.created);
    assert.deepEqual(counts, { created: 2, released: 2 });
  } finally {
    await receiver.close();
  }
});

test("refuse throws a RangeError for a status that is not an integer from 400 to 599", () => {
  for (const status of [200, 399, 600, 401.5, Number.NaN]) assert.throws(() => refuse(status, "No."), RangeError, String(status));
  assert.equal(refuse(400, "No.").status, 400);
  assert.equal(refuse(599, "No.").status, 599);
});
