import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect, Exit, Fiber, Layer } from "effect";

import { NodeServer } from "../src/node.ts";

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
