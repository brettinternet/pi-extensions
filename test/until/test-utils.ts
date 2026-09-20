export async function waitFor(
  assertion: () => void | Promise<void>,
  options: { timeout?: number; interval?: number } = {},
): Promise<void> {
  const timeout = options.timeout ?? 1_000;
  const interval = options.interval ?? 10;
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw lastError instanceof Error ? lastError : new Error("waitFor timed out");
}
