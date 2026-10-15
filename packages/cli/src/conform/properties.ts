/**
 * Property-based checks for the guarantees of spec/invocation.md#cancellation-and-concurrency, through each remote
 * binding. fast-check makes random sets of concurrent calls and cancellations.
 */
import type { Outcome } from "@acid-cat/spec-ts";
import fc from "fast-check";

import { Checks, Deadline, expect, expectEqual, GUARD } from "./check.ts";
import type { Guard } from "./check.ts";
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

export async function mcpInvoke(url: string, signal?: AbortSignal): Promise<{ readonly invoke: Invoke; close(): Promise<void> }> {
  const client = await mcpClient(url, signal);
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
async function heldKeys(invoke: Invoke, signal: AbortSignal): Promise<readonly string[]> {
  const outcome = await invoke("fixture.held", {}, signal);
  expect("ok" in outcome && outcome.ok, `fixture.held gave ${JSON.stringify(outcome)}`);
  return (outcome.value as { readonly keys: readonly string[] }).keys;
}

/** Read fixture.held through the binding until `condition` is true, until the deadline. */
const untilHeld = (invoke: Invoke, deadline: Deadline, condition: (held: readonly string[]) => boolean, what: string) =>
  deadline.until((signal) => heldKeys(invoke, signal), condition, what);

/**
 * Which calls of one run of the property are cancelled. Each run cancels at least one call and keeps at least one, so
 * that each run tests both sides of the guarantee.
 */
export const cancellations: fc.Arbitrary<readonly boolean[]> = fc
  .array(fc.boolean(), { minLength: 0, maxLength: 3 })
  .chain((others) => fc.shuffledSubarray([true, false, ...others], { minLength: others.length + 2 }));

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
async function cancelSome(invoke: Invoke, calls: readonly HoldingCall[], deadline: Deadline): Promise<void> {
  const keys = calls.map((call) => call.key);
  await untilHeld(invoke, deadline, (held) => keys.every((key) => held.includes(key)), `the calls that hold ${keys.join(", ")}`);

  const cancelled = calls.filter((call) => call.cancelled);
  const kept = calls.filter((call) => !call.cancelled);
  for (const call of cancelled) call.controller.abort(call.reason);
  for (const call of cancelled) {
    const settled = await deadline.within(call.settled, `the cancelled call that held ${call.key}`);
    expect(isCancellation(settled, call.reason), `a cancelled call gave ${describe(settled)}`);
  }
  await untilHeld(
    invoke,
    deadline,
    (held) => cancelled.every((call) => !held.includes(call.key)),
    `the stop of the cancelled calls that held ${cancelled.map((call) => call.key).join(", ")}`,
  );
  const held = await deadline.within(heldKeys(invoke, deadline.signal), "fixture.held");
  for (const call of kept) expect(held.includes(call.key), `the call that holds ${call.key} was not cancelled, but it stopped`);

  for (const call of kept) {
    const released = await deadline.within(invoke("fixture.release", { key: call.key }, deadline.signal), `the release of ${call.key}`);
    expectEqual(released, { ok: true, value: { released: 1 } }, `the release of ${call.key}`);
    const settled = await deadline.within(call.settled, `the call that held ${call.key}, after its release`);
    expect("outcome" in settled, `a call that was not cancelled gave ${describe(settled)}`);
    expectEqual(settled.outcome, { ok: true, value: { key: call.key } }, `the outcome of the call that held ${call.key}`);
  }
}

/**
 * Check a property. Stop at the first failure, with no shrinking, because each run can wait up to the guard. The
 * error gives the input and the reason of the failure.
 */
async function holds<T>(property: fc.IAsyncProperty<T>, options: { readonly numRuns: number }): Promise<void> {
  const details = await fc.check(property, { ...options, endOnFailure: true });
  if (!details.failed) return;
  const reason = details.errorInstance instanceof Error ? details.errorInstance.message : String(details.errorInstance);
  throw new Error(`for ${JSON.stringify(details.counterexample)}: ${reason}`);
}

export async function checkProperties(binding: string, invoke: Invoke, guard: Guard = GUARD): Promise<Checks> {
  const checks = new Checks(`${binding} properties`, guard);

  await checks.run("concurrent calls each get exactly their own outcome", RULE, async (deadline) => {
    await holds(
      fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 12 }), async (operations) => {
        const outcomes = await deadline.within(Promise.all(operations.map((op) => callFor(invoke, op, deadline.signal))), "the concurrent calls");
        operations.forEach((op, index) => expect(agrees(op, outcomes[index]!), `${op.kind} gave ${JSON.stringify(outcomes[index])}`));
      }),
      { numRuns: 25 },
    );
  });

  await checks.run("cancelling a call affects only that call", RULE, async (deadline) => {
    await holds(
      fc.asyncProperty(cancellations, async (cancel) => {
        const calls = cancel.map((cancelled) => {
          const key = nextKey();
          const controller = new AbortController();
          const reason = new Error(`acid-cat conform cancelled the call that holds ${key}`);
          const settled: Promise<Settled> = invoke("fixture.hold", { key }, AbortSignal.any([controller.signal, deadline.signal])).then(
            (outcome) => ({ outcome }),
            (error: unknown) => ({ rejected: error }),
          );
          return { key, cancelled, controller, reason, settled };
        });
        try {
          await cancelSome(invoke, calls, deadline);
        } finally {
          // A call that an implementation did not stop would hold forever. Release each call, then stop waiting for
          // the calls on the side of the client, so that the checks end. The cleanup has its own deadline, because
          // the deadline of the check can be over.
          const cleanup = new Deadline(deadline.guard);
          await Promise.allSettled(calls.map((call) => cleanup.within(invoke("fixture.release", { key: call.key }, cleanup.signal), `the release of ${call.key}`)));
          for (const call of calls) call.controller.abort(call.reason);
          await Promise.allSettled(calls.map((call) => cleanup.within(call.settled, `the call that held ${call.key}`)));
          cleanup.end();
        }
      }),
      { numRuns: 5 },
    );
  });

  return checks;
}
