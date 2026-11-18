import { deadline } from "./deadline.ts";

export async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  const end = Date.now() + deadline;
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`The condition did not become true within ${deadline} ms.`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
