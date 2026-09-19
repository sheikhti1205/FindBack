/**
 * Central reporting hook (WP10 #22). All console noise is banned by lint;
 * anything worth recording goes through here so it can later fan out to a
 * crash reporter without touching call sites.
 */
export function logError(...args: unknown[]): void {
  // eslint-disable-next-line no-console -- single sanctioned call site; import this instead.
  console.error(...args);
}
