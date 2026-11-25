/**
 * Import this module before a command-line program with `node --import`. When the run of the program has ended and the
 * process would exit, the process goes on as a host that does more work: it counts the interrupts with its own listener,
 * writes each one to standard error, and exits with 0 when standard input ends.
 */
process.once("beforeExit", () => {
  let interrupts = 0;
  process.on("SIGINT", () => {
    interrupts += 1;
    process.stderr.write(`interrupt ${interrupts}\n`);
  });
  process.stdin.on("end", () => {
    process.stderr.write("still running\n");
    process.exit(0);
  });
  process.stdin.resume();
  process.stderr.write("returned\n");
});
