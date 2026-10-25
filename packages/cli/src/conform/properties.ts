/**
 * Property-based checks for the guarantees of spec/invocation.md#cancellation-and-concurrency, through each remote
 * binding. fast-check makes random sets of concurrent calls and cancellations.
 */
import { randomUUID } from "node:crypto";

import type { Outcome } from "@acid-cat/spec-ts";
import { SdkError } from "@modelcontextprotocol/client";
import fc from "fast-check";

import { isStringArray, memberOf, parseJson, readJson } from "../json.ts";
import type { JsonObject } from "../json.ts";
import { Checks, expect, isOutcome, until } from "./check.ts";
import { mcpClient } from "./mcp.ts";

const RULE = "spec/invocation.md#cancellation-and-concurrency";

/** A call through one binding. When the signal aborts, the client stops the call and rejects with the reason of the signal. */
export type Invoke = (id: string, input: JsonObject, signal?: AbortSignal) => Promise<Outcome<unknown, unknown>>;

export function httpInvoke(base: string): Invoke {
  return async (id, input, signal) => {
    const response = await fetch(`${base}/capabilities/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      ...(signal ? { signal } : {}),
    });
    const outcome = await readJson(response);
    if (!isOutcome(outcome)) throw new Error(`POST /capabilities/${id} gave ${JSON.stringify(outcome)}, which is not an outcome`);
    return outcome;
  };
}

export async function mcpInvoke(url: string, signal: AbortSignal): Promise<{ readonly invoke: Invoke; close(): Promise<void> }> {
  const client = await mcpClient(url, signal);
  return {
    invoke: async (id, input, signal) => {
      try {
        const result = await client.callTool({ name: id, arguments: input }, signal ? { signal } : undefined);
        const first = result.content[0];
        const body = parseJson(first?.type === "text" ? first.text : "null");
        if (result.isError !== true) return { ok: true, value: result.structuredContent ?? body };
        if (!isOutcome(body)) throw new Error(`the error result of ${id} gave ${JSON.stringify(body)}, which is not an outcome`);
        return body;
      } catch (error) {
        // The MCP client rejects a call that its signal aborts with an SdkError that has the reason as its message.
        if (signal?.aborted && error instanceof SdkError && error.message === String(signal.reason)) throw signal.reason;
        if (memberOf(error, "code") === -32602) return { kind: "unknown-capability", message: String(error) };
        throw error;
      }
    },
    close: () => client.close(),
  };
}

type Operation =
  | { readonly kind: "echo"; readonly text: string }
  | { readonly kind: "refuse" }
  | { readonly kind: "crash" }
  | { readonly kind: "invalid" };

const operation: fc.Arbitrary<Operation> = fc.oneof(
  fc.string({ maxLength: 40 }).map((text) => ({ kind: "echo", text }) as const),
  fc.constant({ kind: "refuse" } as const),
  fc.constant({ kind: "crash" } as const),
  fc.constant({ kind: "invalid" } as const),
);

/** The outcome that an operation must have. */
function agrees(operation: Operation, outcome: Outcome<unknown, unknown>): boolean {
  switch (operation.kind) {
    case "echo":
      return "ok" in outcome && outcome.ok && JSON.stringify(outcome.value) === JSON.stringify({ text: operation.text });
    case "refuse":
      return "ok" in outcome && !outcome.ok && memberOf(outcome.error, "_tag") === "Refused";
    case "crash":
      return "kind" in outcome && outcome.kind === "internal";
    case "invalid":
      return "kind" in outcome && outcome.kind === "invalid-input";
  }
}

const callFor = (invoke: Invoke, operation: Operation, signal: AbortSignal) => {
  switch (operation.kind) {
    case "echo":
      return invoke("fixture.echo", { text: operation.text }, signal);
    case "refuse":
      return invoke("fixture.refuse", {}, signal);
    case "crash":
      return invoke("fixture.crash", {}, signal);
    case "invalid":
      return invoke("fixture.echo", { text: 0 }, signal);
  }
};

/** How a call through a binding ended: with an outcome, or with a rejection. */
type Settled = { readonly outcome: Outcome<unknown, unknown> } | { readonly rejected: unknown };

const settle = (call: Promise<Outcome<unknown, unknown>>): Promise<Settled> =>
  call.then(
    (outcome) => ({ outcome }),
    (rejected: unknown) => ({ rejected }),
  );

const describe = (settled: Settled): string => ("outcome" in settled ? JSON.stringify(settled.outcome) : `the rejection ${String(settled.rejected)}`);

/**
 * True if a call ended as a cancellation: with the call failure `cancelled`, or with the rejection that the client gives
 * when it aborts the call, which is the reason of its signal. Any other rejection is not a cancellation.
 */
const isCancellation = (settled: Settled, reason: unknown): boolean =>
  "outcome" in settled ? "kind" in settled.outcome && settled.outcome.kind === "cancelled" : settled.rejected === reason;

/** The keys of the calls that hold now, as fixture.held gives them through the binding. */
async function heldKeys(invoke: Invoke, signal: AbortSignal): Promise<readonly string[]> {
  const outcome = await invoke("fixture.held", {}, signal);
  expect("ok" in outcome && outcome.ok, `fixture.held gave ${JSON.stringify(outcome)}`);
  const keys = memberOf(outcome.value, "keys");
  expect(isStringArray(keys), `fixture.held gave ${JSON.stringify(outcome)}, with no list of keys`);
  return keys;
}

/**
 * Start one call to fixture.hold for each flag, and wait until each call holds. Then cancel each call whose flag is
 * true, and release the others. Each cancelled call must end as a cancellation and stop holding. Each other call must
 * hold until it is released, and then give its own key. At the end, the cleanup releases every key, with a signal that
 * aborts `deadline` milliseconds later.
 */
async function cancelSome(invoke: Invoke, flags: readonly boolean[], signal: AbortSignal, deadline: number): Promise<void> {
  const calls = flags.map((cancelled) => {
    const key = randomUUID();
    const controller = new AbortController();
    const reason = new Error(`acid-cat conform cancels the call that holds ${key}`);
    const settled = settle(invoke("fixture.hold", { key }, AbortSignal.any([controller.signal, signal])));
    return { key, cancelled, cancel: () => controller.abort(reason), reason, settled };
  });
  const cancelled = calls.filter((call) => call.cancelled);
  const kept = calls.filter((call) => !call.cancelled);
  const read = () => heldKeys(invoke, signal);
  try {
    await until("fixture.held gives the key of each call", read, (held) => calls.every((call) => held.includes(call.key)), signal);
    for (const call of cancelled) call.cancel();
    for (const call of cancelled) {
      const settled = await call.settled;
      expect(isCancellation(settled, call.reason), `a cancelled call gave ${describe(settled)}`);
    }
    const held = await until("the cancelled calls stop holding", read, (held) => cancelled.every((call) => !held.includes(call.key)), signal);
    expect(kept.every((call) => held.includes(call.key)), "a call that was not cancelled stopped holding");
    for (const call of kept) {
      await invoke("fixture.release", { key: call.key }, signal);
      const settled = await call.settled;
      const own = { ok: true, value: { key: call.key } };
      expect("outcome" in settled && JSON.stringify(settled.outcome) === JSON.stringify(own), `a call that was not cancelled gave ${describe(settled)}`);
    }
  } finally {
    const cleanup = AbortSignal.timeout(deadline);
    await Promise.all(calls.map((call) => invoke("fixture.release", { key: call.key }, cleanup).catch(() => undefined)));
  }
}

/** Two calls or more, at least one of them cancelled and at least one not. */
const cancellations = fc.array(fc.boolean(), { minLength: 2, maxLength: 5 }).filter((flags) => flags.includes(true) && flags.includes(false));

export async function checkProperties(binding: string, invoke: Invoke, deadline: number): Promise<Checks> {
  const checks = new Checks(`${binding} properties`, deadline);

  await checks.run("concurrent calls each get exactly their own outcome", RULE, async (signal) => {
    await fc.assert(
      fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 12 }), async (operations) => {
        fc.pre(!signal.aborted);
        const calls = await Promise.all(operations.map(async (op) => ({ op, outcome: await callFor(invoke, op, signal) })));
        calls.forEach(({ op, outcome }) => expect(agrees(op, outcome), `${op.kind} gave ${JSON.stringify(outcome)}`));
      }),
      { numRuns: 25, includeErrorInReport: true },
    );
  });

  await checks.run("cancelling a call affects only that call", RULE, async (signal) => {
    await fc.assert(
      fc.asyncProperty(cancellations, (flags) => {
        fc.pre(!signal.aborted);
        return cancelSome(invoke, flags, signal, deadline);
      }),
      { numRuns: 5, includeErrorInReport: true },
    );
  });

  return checks;
}
