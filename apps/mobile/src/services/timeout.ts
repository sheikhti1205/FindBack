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

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}

export function withTimeout<T>(
  task: () => Promise<T>,
  ms: number,
  message: string,
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BootTimeoutError(message)), ms);
  });
  const aborted = new Promise<never>((_, reject) => {
    if (!signal) return;
    onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const raced = signal
    ? Promise.race([task(), timeout, aborted])
    : Promise.race([task(), timeout]);
  return raced.finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  });
}
