import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { test } from "node:test";

import { serve } from "../src/node.ts";
import { closeDuringResponse, idleConnection } from "../../../test-support/idle-connection.ts";

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

test("routes go to the longest prefix that matches, other paths get 404, and the prefix / matches the paths that no other prefix matches", async () => {
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

  await using rooted = await serve({ "/": () => new Response("root"), "/mcp": () => new Response("mcp") }, { port: 0 });
  assert.equal(await (await fetch(`${rooted.url}/anything`)).text(), "root");
  assert.equal(await (await fetch(`${rooted.url}/mcp`)).text(), "mcp");
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

test("serve rejects when the port is in use", async () => {
  await using first = await serve(() => new Response("first"), { port: 0 });
  await assert.rejects(serve(() => new Response("second"), { port: first.port }), { code: "EADDRINUSE" });
});

test("close stops the server", async () => {
  const served = await serve(() => new Response("ok"), { port: 0 });
  await served.close();
  await assert.rejects(fetch(served.url));
});

test("a request on an idle connection at the moment when the server closes it gets no answer", async () => {
  const server = createServer({ keepAliveTimeout: 1, keepAliveTimeoutBuffer: 0 }, (_incoming, outgoing) => outgoing.end("ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const client = connect(port, "127.0.0.1");
  const request = "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";
  // Node.js closes an idle connection when its socket times out. A listener before that of Node.js sends the second
  // request at that moment, as a client does that reuses the connection then.
  server.on("connection", (socket: Socket) => socket.prependListener("timeout", () => client.write(request)));
  let answers = "";
  client.setEncoding("utf-8").on("data", (chunk: string) => (answers += chunk));
  const ended = new Promise<string>((resolve) => {
    client.on("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
    client.on("close", () => resolve("closed"));
  });
  client.write(request);
  const outcome = await ended;
  server.close();
  assert.equal(answers.match(/HTTP\/1\.1 200/g)?.length, 1, "only the first request gets an answer");
  assert.ok(["ECONNRESET", "closed"].includes(outcome), outcome);
});

test("serve closes no idle connection and sends no Keep-Alive header, so a client never sends a request while the server closes the connection", async () => {
  await using served = await serve(() => new Response("ok"), { port: 0 });
  assert.deepEqual(await idleConnection(served.url), { idleTimeoutMs: undefined, keepAlive: null });
});

test("after close, serve closes each connection when its response is complete", async (t) => {
  await closeDuringResponse(t, (handler) => serve(handler, { port: 0 }));
});
