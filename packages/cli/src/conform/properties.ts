/**
 * Property-based checks for the guarantees of spec/invocation.md#cancellation-and-concurrency, through each remote
 * binding. fast-check makes random sets of concurrent calls and cancellations.
 */
import type { Outcome } from "@acid-cat/spec";
import fc from "fast-check";

import { Checks, expect } from "./check.ts";
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
          const controller = new AbortController();
          const outcome = invoke("fixture.slow", { milliseconds: 200 }, controller.signal).catch(() => "aborted" as const);
          if (cancelled) setTimeout(() => controller.abort(), 20);
          return { cancelled, outcome };
        });
        for (const call of calls) {
          const outcome = await call.outcome;
          if (!call.cancelled) expect(outcome !== "aborted" && "ok" in outcome && outcome.ok, `a call that was not cancelled gave ${JSON.stringify(outcome)}`);
          else expect(outcome === "aborted" || ("kind" in outcome && outcome.kind === "cancelled"), `a cancelled call gave ${JSON.stringify(outcome)}`);
        }
      }),
      { numRuns: 5 },
    );
  });

  return checks;
}
