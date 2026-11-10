/**
 * Streams of messages for the bindings that serve events through a connection: the next occurrence or a sign that the
 * stream is idle, and a web stream of text.
 */
import type { Occurrence } from "@acid-cat/spec-ts";

import type { Occurrences } from "./subscription.ts";

/** One pull of a subscription: the next step, the error that ends it, or `idle` when nothing came in time. */
export type Pulled<Payload> =
  | { readonly idle: true }
  | { readonly step: IteratorResult<Occurrence<Payload>, undefined> }
  | { readonly error: unknown };

/**
 * A function that pulls the next step of a subscription. It gives `idle` when no step comes within `idleMs`
 * milliseconds. The `next()` that waits is kept for the next pull, so no occurrence is lost.
 */
export function idlePuller<Payload>(occurrences: Occurrences<Payload>, idleMs: number): () => Promise<Pulled<Payload>> {
  let pending: Promise<Pulled<Payload>> | undefined;
  return async () => {
    const next = (pending ??= occurrences.next().then(
      (step): Pulled<Payload> => ({ step }),
      (error: unknown): Pulled<Payload> => ({ error }),
    ));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<Pulled<Payload>>((resolve) => {
      timer = setTimeout(() => resolve({ idle: true }), idleMs);
    });
    try {
      const pulled = await Promise.race([next, idle]);
      if (!("idle" in pulled)) pending = undefined;
      return pulled;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * A web stream of text. The stream calls `produce` each time that the client can take more: it gives the next messages,
 * or `undefined` at the end. When the client cancels the stream, the stream calls `cancel`. `release` runs one time, when
 * the stream ends in any way.
 */
export function textStream(produce: () => Promise<readonly string[] | undefined>, cancel: () => void, release: () => Promise<void>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let released = false;
  // A pull can still wait for `produce` when the client cancels. Its messages then go nowhere.
  let cancelled = false;
  const releaseOnce = async () => {
    if (released) return;
    released = true;
    await release();
  };
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let messages: readonly string[] | undefined;
        try {
          messages = await produce();
        } catch (error) {
          if (!cancelled) controller.error(error);
          await releaseOnce();
          return;
        }
        if (cancelled) return;
        if (messages === undefined) {
          controller.close();
          await releaseOnce();
          return;
        }
        controller.enqueue(encoder.encode(messages.join("")));
      },
      async cancel() {
        cancelled = true;
        cancel();
        await releaseOnce();
      },
    },
    { highWaterMark: 0 },
  );
}
