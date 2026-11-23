import { existsSync, writeFileSync } from "node:fs";

const record = process.env.INTERRUPT_PROBE_RECORD;
if (record === undefined) throw new Error("Give the path of the record in INTERRUPT_PROBE_RECORD.");
const hold = process.env.INTERRUPT_PROBE_HOLD;
const HOLD_LIMIT_MS = 10_000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

let interrupts = 0;
let handling = false;

// The probe is imported before the program, so Node calls this listener before the listeners of the program.
process.on("SIGINT", () => {
  interrupts += 1;
  handling = true;
  // Node runs the next-tick queue after it calls every listener of the signal.
  process.nextTick(() => (handling = false));
  if (hold !== undefined && interrupts === 1) holdEventLoopUntilTestSendsSecondInterrupt(hold);
});

// Unix merges a pending signal with the next one of the same kind.
function holdEventLoopUntilTestSendsSecondInterrupt(hold: string) {
  writeFileSync(`${hold}.received`, "");
  const start = Date.now();
  while (!existsSync(`${hold}.go`) && Date.now() - start < HOLD_LIMIT_MS) Atomics.wait(sleeper, 0, 0, 5);
}

process.on("exit", () => writeFileSync(record, `${handling ? "exit during" : "exit after"} interrupt ${interrupts}`));
