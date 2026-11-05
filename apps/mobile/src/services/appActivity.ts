/** Interruption veto only: no IDs/content, no scheduling or cancellation authority. */
let active = 0;
const listeners = new Set<() => void>();
function notify(): void { for (const listener of [...listeners]) listener(); }
export function appActivityBusy(): boolean { return active > 0; }
export function subscribeAppActivity(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
export function beginAppActivity(): () => void {
  active += 1; notify(); let released = false;
  return () => { if (released) return; released = true; active -= 1; notify(); };
}
export async function duringAppActivity<T>(operation: () => Promise<T>): Promise<T> {
  const release = beginAppActivity();
  try { return await operation(); } finally { release(); }
}
