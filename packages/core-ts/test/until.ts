export async function until(condition: () => boolean | Promise<boolean>, deadlineMs = 1000): Promise<void> {
  const end = Date.now() + deadlineMs;
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`The condition did not become true within ${deadlineMs} ms.`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
