import { writeFileSync } from "node:fs";

/**
 * Import this module before a program with `node --import`. It writes to INTERRUPT_PROBE_RECORD how the program exited:
 * `exit during interrupt 2` when the program exits while Node calls the listeners of the second interrupt, or
 * `exit after interrupt 1` when it exits later, for example at the end of a timer.
 */
const record = process.env.INTERRUPT_PROBE_RECORD;
if (record === undefined) throw new Error("Give the path of the record in INTERRUPT_PROBE_RECORD.");
const pair = process.env.INTERRUPT_PROBE_PAIR;

let interrupts = 0;
let handling = false;

if (pair !== undefined) deliverFirstInterruptWithSecond(pair);

// The probe is imported before the program, so Node calls this listener before the listeners of the program.
process.on("SIGINT", () => {
  interrupts += 1;
  handling = true;
  // Node runs the next-tick queue after it calls every listener of the signal.
  process.nextTick(() => (handling = false));
});

process.on("exit", () => writeFileSync(record, `${handling ? "exit during" : "exit after"} interrupt ${interrupts}`));

/**
 * With INTERRUPT_PROBE_PAIR, the program gets the first interrupt when the second one comes, and the second one in the
 * check phase of the same turn of the event loop. The microtasks of the first interrupt run between the two, but no
 * timer does, so a grace period that starts at the first interrupt cannot end before the second, however slow the
 * computer. The probe writes `<INTERRUPT_PROBE_PAIR>.received` when it gets the first interrupt.
 */
function deliverFirstInterruptWithSecond(pair: string) {
  const emit = process.emit.bind(process);
  const emitInterrupt = () => emit("SIGINT", "SIGINT");
  let first = true;
  // Node binds `process.emit` when the program adds the first listener of a signal, so the probe replaces it before.
  process.emit = (event: string | symbol, ...args: unknown[]): boolean => {
    if (event !== "SIGINT") return emit(event, ...args);
    if (first) {
      first = false;
      writeFileSync(`${pair}.received`, "");
      return true;
    }
    emitInterrupt();
    setImmediate(emitInterrupt);
    return true;
  };
}
