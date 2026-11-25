import type { Clock } from "../src/index.ts";

/** A clock that moves only when the test calls `advance`. A timer of 0 ms or less is due at once, and fires at the next turn of the event loop. */
export class ManualClock implements Clock {
  #time = Date.parse("2026-11-10T09:00:00.000Z");
  #timers: { readonly at: number; readonly callback: () => void }[] = [];

  readonly now = (): number => this.#time;

  readonly schedule = (callback: () => void, ms: number): (() => void) => {
    if (ms <= 0) {
      const immediate = setImmediate(callback);
      return () => clearImmediate(immediate);
    }
    const timer = { at: this.#time + ms, callback };
    this.#timers.push(timer);
    return () => {
      this.#timers = this.#timers.filter((each) => each !== timer);
    };
  };

  /** The number of timers that wait for the clock to move. */
  get pending(): number {
    return this.#timers.length;
  }

  advance(ms: number): void {
    const end = this.#time + ms;
    for (;;) {
      const next = this.#timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (next === undefined) break;
      this.#timers = this.#timers.filter((timer) => timer !== next);
      this.#time = next.at;
      next.callback();
    }
    this.#time = end;
  }
}
