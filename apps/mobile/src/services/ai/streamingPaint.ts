import { diag } from "../diag";

export interface StreamingPaintOptions {
  paint: (cumulativeText: string) => void;
  now?: () => number;
}

/** One instance per generation. flush() is terminal; cancel() drops pending work.
 * Neither clears the UI: the owner clears partial state after its terminal commit.
 * Input is real cumulative provider text, never synthesized typing.
 */
export function createStreamingPaint({ paint, now = () => performance.now() }: StreamingPaintOptions) {
  const started = now();
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest = "";
  let painted = "";
  let chunkCount = 0;
  let paintCount = 0;
  let firstChunkMs = 0;
  let lastChunkMs = 0;
  let firstPaintMs = 0;
  let lastPaintMs = 0;
  let chunkIntervalMs = 0;
  let paintIntervalMs = 0;
  let cadenceMs = 60;

  function metrics(event: string) {
    // Numeric fields only: no text, hashes, photos, model/chat/generation IDs.
    diag(event, { chunkCount, paintCount, firstChunkMs, lastChunkMs,
      firstPaintMs, lastPaintMs, chunkIntervalMs, paintIntervalMs, cadenceMs });
  }
  function clearTimer() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }
  function publish() {
    clearTimer();
    if (closed || latest === painted) return;
    const ms = now() - started;
    paintIntervalMs = paintCount > 0 ? ms - lastPaintMs : 0;
    if (paintCount === 0) firstPaintMs = ms;
    lastPaintMs = ms;
    paintCount++;
    painted = latest;
    paint(latest);
    metrics("ai.stream.paint.update");
  }
  return {
    push(cumulativeText: string) {
      if (closed || cumulativeText === latest || cumulativeText === "") return;
      const ms = now() - started;
      chunkIntervalMs = chunkCount > 0 ? ms - lastChunkMs : 0;
      if (chunkCount === 0) firstChunkMs = ms;
      else cadenceMs = Math.max(50, Math.min(80, cadenceMs * 0.75 + chunkIntervalMs * 2 * 0.25));
      lastChunkMs = ms;
      chunkCount++;
      latest = cumulativeText;
      const sincePaint = ms - lastPaintMs;
      const boundary = /(?:\n|[.!?]\s*)$/.test(latest);
      if (paintCount === 0 || sincePaint >= cadenceMs || (boundary && sincePaint >= 25)) {
        publish();
      } else if (timer === undefined) {
        // Fixed deadline: later chunks replace the payload, NOT the timer.
        timer = setTimeout(publish, cadenceMs - sincePaint);
      }
    },
    flush() {
      if (closed) return;
      publish();
      closed = true;
      latest = painted = "";
      metrics("ai.stream.paint.complete");
    },
    cancel() {
      if (closed) return;
      clearTimer();
      closed = true;
      latest = painted = "";
      metrics("ai.stream.paint.cancel");
    },
  };
}
