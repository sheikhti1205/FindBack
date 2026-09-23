/**
 * Development/test-only fetch duration instrumentation.
 *
 * Records only a stage label plus a duration — never request data, response
 * data, filters, ids, counts, or errors — so there is nothing sensitive to
 * leak and nothing to mistake for production analytics. Zero cost in release
 * builds: events are not recorded and the log stays empty.
 */
export interface LoadTiming {
  stage: string;
  durationMs: number;
}

const timings: LoadTiming[] = [];

export function recordLoadTiming(stage: string, durationMs: number): void {
  if (!import.meta.env.DEV) return;
  timings.push({ stage, durationMs });
}

export function getLoadTimings(): LoadTiming[] {
  return [...timings];
}

export function clearLoadTimings(): void {
  timings.length = 0;
}
