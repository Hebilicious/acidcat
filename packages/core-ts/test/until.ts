/** The test timeout stops a wait that does not end. */
export async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  while (!(await condition())) await new Promise((resolve) => setTimeout(resolve, 2));
}
