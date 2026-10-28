import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { test } from "node:test";

import { Effect, Exit, Fiber, Layer, Scope } from "effect";

import * as NodeServer from "../src/NodeServer.ts";

/** Serve in a scope of its own, which `await using` closes at the end of the block. */
async function serve(handler: NodeServer.WebHandler | NodeServer.Routes, options: NodeServer.ServeOptions) {
  const scope = Effect.runSync(Scope.make());
  const address = await Effect.runPromise(NodeServer.serve(handler, options).pipe(Scope.provide(scope)));
  return { ...address, [Symbol.asyncDispose]: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
}

test("NodeServer.serve serves while its scope is open, and closes the server with the scope", async () => {
  const url = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const served = yield* NodeServer.serve({ "/hello": () => new Response("hello") }, { port: 0 });
        assert.match(served.url, /^http:\/\/127\.0\.0\.1:\d+$/);
        const response = yield* Effect.promise(() => fetch(`${served.url}/hello`));
        assert.equal(yield* Effect.promise(() => response.text()), "hello");
        const missing = yield* Effect.promise(() => fetch(`${served.url}/other`));
        assert.equal(missing.status, 404);
        return served.url;
      }),
    ),
  );
  await assert.rejects(fetch(`${url}/hello`));
});

test("NodeServer.serve fails with ServeError when the port is in use", async () => {
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const first = yield* NodeServer.serve(() => new Response("first"), { port: 0 });
        yield* NodeServer.serve(() => new Response("second"), { port: first.port });
      }),
    ),
  );
  assert.ok(Exit.isFailure(exit));
  assert.match(String(exit.cause), /ServeError/);
});

test("NodeServer.layer serves until the program that launches it is interrupted", async () => {
  const port = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const probe = yield* NodeServer.serve(() => new Response("probe"), { port: 0 });
        return probe.port;
      }),
    ),
  );
  const fiber = Effect.runFork(Layer.launch(NodeServer.layer(() => new Response("launched"), { port })));
  const url = `http://127.0.0.1:${port}`;
  let text: string | undefined;
  for (let attempt = 0; text === undefined && attempt < 100; attempt++) {
    text = await fetch(url).then(
      (response) => response.text(),
      () => new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 10)),
    );
  }
  assert.equal(text, "launched");
  await Effect.runPromise(Fiber.interrupt(fiber));
  await assert.rejects(fetch(url));
});

test("one handler gets all paths, with the full URL, the method, the headers and the body", async () => {
  await using served = await serve(
    async (request) =>
      Response.json({ url: request.url, method: request.method, header: request.headers.get("x-test"), body: await request.text() }),
    { port: 0 },
  );
  const response = await fetch(`${served.url}/a/b?c=1`, { method: "POST", headers: { "x-test": "yes" }, body: "hello" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { url: `${served.url}/a/b?c=1`, method: "POST", header: "yes", body: "hello" });
});

test("the default address is 127.0.0.1, and the URL has the port", async () => {
  await using served = await serve(() => new Response("ok"), { port: 0 });
  assert.match(served.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(served.url, `http://127.0.0.1:${served.port}`);
});

test("routes go to the longest prefix that matches, and other paths get 404", async () => {
  await using served = await serve(
    {
      "/api": () => new Response("api"),
      "/api/admin": () => new Response("admin"),
      "/mcp": () => new Response("mcp"),
    },
    { port: 0 },
  );
  const text = async (path: string) => {
    const response = await fetch(`${served.url}${path}`);
    return `${response.status} ${await response.text()}`;
  };
  assert.equal(await text("/api"), "200 api");
  assert.equal(await text("/api/status"), "200 api");
  assert.equal(await text("/api/admin/users"), "200 admin");
  assert.equal(await text("/mcp"), "200 mcp");
  assert.equal(await text("/apis"), "404 ");
  assert.equal(await text("/"), "404 ");
});

test("the prefix / matches all paths that no other prefix matches", async () => {
  await using served = await serve({ "/": () => new Response("root"), "/mcp": () => new Response("mcp") }, { port: 0 });
  assert.equal(await (await fetch(`${served.url}/anything`)).text(), "root");
  assert.equal(await (await fetch(`${served.url}/mcp`)).text(), "mcp");
});

test("a handler that throws gets 500", async () => {
  await using served = await serve(
    {
      "/throws": () => {
        throw new Error("broken");
      },
      "/rejects": () => Promise.reject(new Error("broken")),
    },
    { port: 0 },
  );
  assert.equal((await fetch(`${served.url}/throws`)).status, 500);
  assert.equal((await fetch(`${served.url}/rejects`)).status, 500);
});

test("the status, the status text and each set-cookie header reach the client", async () => {
  const headers = new Headers({ "content-type": "text/plain" });
  headers.append("set-cookie", "a=1");
  headers.append("set-cookie", "b=2");
  await using served = await serve(() => new Response("made", { status: 201, statusText: "Made", headers }), { port: 0 });
  const response = await fetch(served.url);
  assert.equal(response.status, 201);
  assert.equal(response.statusText, "Made");
  assert.deepEqual(response.headers.getSetCookie(), ["a=1", "b=2"]);
  assert.equal(await response.text(), "made");
});

test("a streamed response reaches the client chunk by chunk", async () => {
  const encoder = new TextEncoder();
  await using served = await serve(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const part of ["one ", "two ", "three"]) controller.enqueue(encoder.encode(part));
            controller.close();
          },
        }),
      ),
    { port: 0 },
  );
  assert.equal(await (await fetch(served.url)).text(), "one two three");
});

test("when the client closes the connection, the signal of the request aborts and the body is cancelled", async () => {
  const aborted = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  await using served = await serve(
    (request) => {
      request.signal.addEventListener("abort", () => aborted.resolve());
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("first"));
            started.resolve();
          },
          cancel() {
            cancelled.resolve();
          },
        }),
      );
    },
    { port: 0 },
  );
  const responded = Promise.withResolvers<number | undefined>();
  const client = httpRequest(served.url, (response) => responded.resolve(response.statusCode));
  client.end();
  assert.equal(await responded.promise, 200);
  await started.promise;
  client.destroy();
  await aborted.promise;
  await cancelled.promise;
});

test("when the client closes the connection before the handler answers, the signal of the request aborts", async () => {
  const entered = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  await using served = await serve(
    (request) => {
      entered.resolve();
      return new Promise<Response>((resolve) => {
        request.signal.addEventListener("abort", () => {
          aborted.resolve();
          resolve(new Response("too late"));
        });
      });
    },
    { port: 0 },
  );
  const client = httpRequest(served.url);
  client.on("error", () => undefined);
  client.end();
  await entered.promise;
  client.destroy();
  await aborted.promise;
});

test("the signal does not abort after a complete response", async () => {
  const signals: AbortSignal[] = [];
  await using served = await serve(
    (request) => {
      signals.push(request.signal);
      return new Response("done");
    },
    { port: 0 },
  );
  assert.equal(await (await fetch(served.url)).text(), "done");
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.aborted, false);
});

