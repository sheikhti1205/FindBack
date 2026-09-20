/**
 * Bounded async operations. Endpoints can hang (Termux boot finding), so
 * boot-critical calls race a timer instead of waiting forever. Timeouts are
 * per-operation: boot restore, profile load, Edge Functions, and uploads each
 * get their own budget — never one short global timeout for everything.
 */
export class BootTimeoutError extends Error {
  constructor(message = "Request timed out") {
    super(message);
    this.name = "BootTimeoutError";
  }
}

export function withTimeout<T>(task: () => Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BootTimeoutError(message)), ms);
  });
  return Promise.race([task(), timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
