import { deadline } from "./deadline.ts";

/** Waits until the condition is true. The deadline only stops a test that hangs: it is not a time that the test waits for. */
export async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  const end = Date.now() + deadline;
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`The condition did not become true within ${deadline} ms.`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
