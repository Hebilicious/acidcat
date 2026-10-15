/**
 * Property-based checks for the guarantees of spec/invocation.md#cancellation-and-concurrency, through each remote
 * binding. fast-check makes random sets of concurrent calls and cancellations.
 */
import type { Outcome } from "@acid-cat/spec-ts";
import fc from "fast-check";

import { Checks, expect, expectEqual } from "./check.ts";
import { mcpClient } from "./mcp.ts";

const RULE = "spec/invocation.md#cancellation-and-concurrency";

/** A call through one binding. A cancelled call can reject. */
export type Invoke = (id: string, input: object, signal?: AbortSignal) => Promise<Outcome<unknown, unknown>>;

export function httpInvoke(base: string): Invoke {
  return async (id, input, signal) => {
    const response = await fetch(`${base}/capabilities/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      ...(signal ? { signal } : {}),
    });
    return (await response.json()) as Outcome<unknown, unknown>;
  };
}

export async function mcpInvoke(url: string): Promise<{ readonly invoke: Invoke; close(): Promise<void> }> {
  const client = await mcpClient(url);
  return {
    invoke: async (id, input, signal) => {
      try {
        const result = (await client.callTool({ name: id, arguments: input as Record<string, unknown> }, signal ? { signal } : undefined)) as {
          content: { text: string }[];
          isError?: boolean;
          structuredContent?: unknown;
        };
        const body = JSON.parse(result.content[0]?.text ?? "null") as Record<string, unknown>;
        if (result.isError !== true) return { ok: true, value: result.structuredContent ?? body };
        return body as Outcome<unknown, unknown>;
      } catch (error) {
        if ((error as { code?: number }).code === -32602) return { kind: "unknown-capability", message: String(error) };
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
      return "ok" in outcome && !outcome.ok && (outcome.error as { _tag?: string })._tag === "Refused";
    case "crash":
      return "kind" in outcome && outcome.kind === "internal";
    case "invalid":
      return "kind" in outcome && outcome.kind === "invalid-input";
  }
}

const callFor = (invoke: Invoke, operation: Operation) => {
  switch (operation.kind) {
    case "echo":
      return invoke("fixture.echo", { text: operation.text });
    case "refuse":
      return invoke("fixture.refuse", {});
    case "crash":
      return invoke("fixture.crash", {});
    case "invalid":
      return invoke("fixture.echo", { text: 0 });
  }
};

/** How a call through a binding ended: with an outcome, or with a rejection. */
type Settled = { readonly outcome: Outcome<unknown, unknown> } | { readonly rejected: unknown };

const describe = (settled: Settled) =>
  "outcome" in settled ? JSON.stringify(settled.outcome) : `a rejection: ${String((settled.rejected as Error | undefined)?.message ?? settled.rejected)}`;

/**
 * True if a call ended as the cancellation that the checks made: the binding gives the call failure `cancelled`, or the
 * call rejects with the reason of its signal. A client library can wrap the reason in its own error, with the text of
 * the reason in its message. Any other rejection is not a cancellation.
 */
function isCancellation(settled: Settled, reason: Error): boolean {
  if ("outcome" in settled) return "kind" in settled.outcome && settled.outcome.kind === "cancelled";
  const rejected = settled.rejected as { readonly message?: unknown } | undefined;
  return rejected === reason || (typeof rejected?.message === "string" && rejected.message.includes(reason.message));
}

let keys = 0;

/** A key that no other call of these checks holds. */
const nextKey = () => `conform-${process.pid}-${++keys}`;

/** The keys of the calls to fixture.hold that hold now, as fixture.held gives them through the binding. */
async function heldKeys(invoke: Invoke): Promise<readonly string[]> {
  const outcome = await invoke("fixture.held", {});
  expect("ok" in outcome && outcome.ok, `fixture.held gave ${JSON.stringify(outcome)}`);
  return (outcome.value as { readonly keys: readonly string[] }).keys;
}

/**
 * Read fixture.held through the binding until `condition` is true. The number of reads is a guard for an implementation
 * that never gets there, so that the check fails instead of waiting forever. It is not part of what the check tests.
 */
async function untilHeld(invoke: Invoke, condition: (held: readonly string[]) => boolean, what: string): Promise<void> {
  for (let read = 1; ; read++) {
    if (condition(await heldKeys(invoke))) return;
    if (read === MAXIMUM_READS) throw new Error(`after ${MAXIMUM_READS} reads of fixture.held: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const MAXIMUM_READS = 2_000;

interface HoldingCall {
  readonly key: string;
  readonly cancelled: boolean;
  readonly controller: AbortController;
  readonly reason: Error;
  readonly settled: Promise<Settled>;
}

/**
 * Wait until each call holds, cancel the calls that `cancelled` marks, and check that only they stop: each one ends as
 * cancelled and stops holding, and each other call still holds, then gives its own key when it is released.
 */
async function cancelSome(invoke: Invoke, calls: readonly HoldingCall[]): Promise<void> {
  const keys = calls.map((call) => call.key);
  await untilHeld(invoke, (held) => keys.every((key) => held.includes(key)), `the calls must hold ${keys.join(", ")}`);

  const cancelled = calls.filter((call) => call.cancelled);
  const kept = calls.filter((call) => !call.cancelled);
  for (const call of cancelled) call.controller.abort(call.reason);
  for (const call of cancelled) {
    const settled = await call.settled;
    expect(isCancellation(settled, call.reason), `a cancelled call gave ${describe(settled)}`);
  }
  await untilHeld(
    invoke,
    (held) => cancelled.every((call) => !held.includes(call.key)),
    `the cancelled calls must stop holding ${cancelled.map((call) => call.key).join(", ")}`,
  );
  const held = await heldKeys(invoke);
  for (const call of kept) expect(held.includes(call.key), `the call that holds ${call.key} was not cancelled, but it stopped`);

  for (const call of kept) {
    const released = await invoke("fixture.release", { key: call.key });
    expectEqual(released, { ok: true, value: { released: 1 } }, `the release of ${call.key}`);
    const settled = await call.settled;
    expect("outcome" in settled, `a call that was not cancelled gave ${describe(settled)}`);
    expectEqual(settled.outcome, { ok: true, value: { key: call.key } }, `the outcome of the call that held ${call.key}`);
  }
}

export async function checkProperties(binding: string, invoke: Invoke): Promise<Checks> {
  const checks = new Checks(`${binding} properties`);

  await checks.run("concurrent calls each get exactly their own outcome", RULE, async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 12 }), async (operations) => {
        const outcomes = await Promise.all(operations.map((op) => callFor(invoke, op)));
        operations.forEach((op, index) => expect(agrees(op, outcomes[index]!), `${op.kind} gave ${JSON.stringify(outcomes[index])}`));
      }),
      { numRuns: 25 },
    );
  });

  await checks.run("cancelling a call affects only that call", RULE, async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.boolean(), { minLength: 2, maxLength: 5 }), async (cancel) => {
        const calls = cancel.map((cancelled) => {
          const key = nextKey();
          const controller = new AbortController();
          const reason = new Error(`acid-cat conform cancelled the call that holds ${key}`);
          const settled: Promise<Settled> = invoke("fixture.hold", { key }, controller.signal).then(
            (outcome) => ({ outcome }),
            (error: unknown) => ({ rejected: error }),
          );
          return { key, cancelled, controller, reason, settled };
        });
        try {
          await cancelSome(invoke, calls);
        } finally {
          // A call that an implementation did not stop would hold forever. Release it, so that the checks can end.
          await Promise.allSettled(calls.map((call) => invoke("fixture.release", { key: call.key })));
          await Promise.allSettled(calls.map((call) => call.settled));
        }
      }),
      { numRuns: 5 },
    );
  });

  return checks;
}
