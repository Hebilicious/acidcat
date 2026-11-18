import { writeFileSync } from "node:fs";

const record = process.env.INTERRUPT_PROBE_RECORD;
if (record === undefined) throw new Error("Give the path of the record in INTERRUPT_PROBE_RECORD.");

let interrupts = 0;
let handling = false;

process.on("SIGINT", () => {
  interrupts += 1;
  handling = true;
  // Node runs the next-tick queue after it calls every listener of the signal.
  process.nextTick(() => (handling = false));
});

process.on("exit", () => writeFileSync(record, `${handling ? "exit during" : "exit after"} interrupt ${interrupts}`));
