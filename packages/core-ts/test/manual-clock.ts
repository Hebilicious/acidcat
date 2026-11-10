/** A clock that only the test moves, for poll leases and webhook lifetimes. */
import type { Clock } from "../src/index.ts";

export class ManualClock implements Clock {
  #time = Date.parse("2026-11-10T09:00:00.000Z");
  #timers: { readonly at: number; readonly callback: () => void }[] = [];

  readonly now = (): number => this.#time;

  readonly schedule = (callback: () => void, ms: number): (() => void) => {
    const timer = { at: this.#time + ms, callback };
    this.#timers.push(timer);
    return () => {
      this.#timers = this.#timers.filter((each) => each !== timer);
    };
  };

  /** Move the time forward, and call each timer that is due, in order. */
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
