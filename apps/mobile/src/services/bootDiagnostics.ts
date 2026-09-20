/**
 * Lightweight structured boot diagnostics, debug builds only. Records the
 * boot stage sequence so a frozen or slow startup can be diagnosed from the
 * device instead of guessed at. Zero cost in release builds: events are not
 * recorded and the log stays empty.
 */
export interface BootEvent {
  stage: string;
  atMs: number;
  detail?: string;
}

const events: BootEvent[] = [];

export function recordBootEvent(stage: string, detail?: string): void {
  if (!import.meta.env.DEV) return;
  events.push({ stage, atMs: Date.now(), detail });
}

export function getBootDiagnostics(): BootEvent[] {
  return [...events];
}

export function clearBootDiagnostics(): void {
  events.length = 0;
}
