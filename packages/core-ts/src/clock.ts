export interface Clock {
  /** The current time, in milliseconds since the epoch. */
  readonly now: () => number;
  /** Call `callback` after `ms` milliseconds. The result cancels the timer. */
  readonly schedule: (callback: () => void, ms: number) => () => void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  schedule: (callback, ms) => {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};

/** The clock of the system, whose timers do not keep the process running. */
export const backgroundClock: Clock = {
  now: () => Date.now(),
  schedule: (callback, ms) => {
    const timer = setTimeout(callback, ms);
    if (typeof timer === "object") timer.unref();
    return () => clearTimeout(timer);
  },
};

/** Wait `ms` milliseconds on a clock. The wait ends early, with `false`, when the signal aborts. */
export function sleep(clock: Clock, ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const stop = () => {
      cancel();
      resolve(false);
    };
    const cancel = clock.schedule(() => {
      signal.removeEventListener("abort", stop);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });
}
