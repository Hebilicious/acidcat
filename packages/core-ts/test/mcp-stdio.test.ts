import assert from "node:assert/strict";
import { test } from "node:test";

import { runMcpStdio } from "../src/index.ts";
import { fixture, options } from "./fixture.ts";

/** Standard input that the test writes line by line, and then ends. */
function lines() {
  const queue: string[] = [];
  let ended = false;
  let wake = () => {};
  async function* input(): AsyncGenerator<string> {
    for (;;) {
      const line = queue.shift();
      if (line !== undefined) {
        yield `${line}\n`;
        continue;
      }
      if (ended) return;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  }
  return {
    input: input(),
    send: (message: object) => {
      queue.push(JSON.stringify(message));
      wake();
    },
    end: () => {
      ended = true;
      wake();
    },
  };
}

test("runMcpStdio answers the lines of its input, and resolves when the input ends", async () => {
  const stdin = lines();
  const written: unknown[] = [];
  let answered = () => {};
  const served = runMcpStdio(fixture, { name: "fixture", version: "0.0.0", ...options() }, {
    input: stdin.input,
    write: (text) => {
      written.push(JSON.parse(text));
      answered();
    },
  });
  const response = (id: number) =>
    new Promise<unknown>((resolve) => {
      const find = () => written.find((message) => typeof message === "object" && message !== null && "id" in message && message.id === id);
      answered = () => {
        const found = find();
        if (found !== undefined) resolve(found);
      };
      answered();
    });

  stdin.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
  assert.deepEqual(await response(1), {
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "fixture", version: "0.0.0" },
      instructions: fixture.description,
    },
  });
  stdin.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "fixture.echo", arguments: { text: "hello" } } });
  assert.deepEqual(await response(2), {
    jsonrpc: "2.0",
    id: 2,
    result: { content: [{ type: "text", text: '{"text":"hello"}' }], structuredContent: { text: "hello" } },
  });
  stdin.end();
  await served;
});
