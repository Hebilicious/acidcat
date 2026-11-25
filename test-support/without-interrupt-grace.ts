/**
 * Import this module before a program with `node --import`. A timer that the program starts while Node calls the
 * listeners of an interrupt never runs, so the program cannot exit at the end of its grace period. A test then sees how
 * the program ends by itself after an interrupt, however slow the computer: a grace period that starts at the interrupt
 * can end before a cancellation that takes several turns of the event loop.
 */
const start = globalThis.setTimeout;
let interrupting = false;

// The probe is imported before the program, so Node calls this listener before the listeners of the program.
process.on("SIGINT", () => {
  interrupting = true;
  // Node runs the next-tick queue after it calls every listener of the signal.
  process.nextTick(() => (interrupting = false));
});

function heldDuringAnInterrupt(...args: Parameters<typeof setTimeout>): ReturnType<typeof setTimeout> {
  if (!interrupting) return start(...args);
  const [, delay] = args;
  return start(() => undefined, delay);
}

Reflect.set(globalThis, "setTimeout", heldDuringAnInterrupt);
