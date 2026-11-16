import type { Occurrence } from "@acid-cat/spec-ts";

import type { Occurrences } from "./subscription.ts";

export type Pulled<Payload> =
  | { readonly idle: true }
  | { readonly step: IteratorResult<Occurrence<Payload>, undefined> }
  | { readonly error: unknown };

export function idlePuller<Payload>(occurrences: Occurrences<Payload>, idleMs: number): () => Promise<Pulled<Payload>> {
  let nextKeptAcrossIdlePulls: Promise<Pulled<Payload>> | undefined;
  return async () => {
    const next = (nextKeptAcrossIdlePulls ??= occurrences.next().then(
      (step): Pulled<Payload> => ({ step }),
      (error: unknown): Pulled<Payload> => ({ error }),
    ));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<Pulled<Payload>>((resolve) => {
      timer = setTimeout(() => resolve({ idle: true }), idleMs);
    });
    try {
      const pulled = await Promise.race([next, idle]);
      if (!("idle" in pulled)) nextKeptAcrossIdlePulls = undefined;
      return pulled;
    } finally {
      clearTimeout(timer);
    }
  };
}

export function textStream(produce: () => Promise<readonly string[] | undefined>, cancel: () => void, release: () => Promise<void>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let released = false;
  // A ReadableStream can call `cancel` while a `pull` still waits for `produce`.
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
