/**
 * Request coordinator: orchestration around one `ProviderAdapter.complete`
 * call (packet R1).
 *
 * The coordinator owns observable phase reporting (`queued`, `sending`,
 * `first-token`, `streaming`, `retrying`, `complete`, `failed`, `cancelled`
 * per the frozen contract), `AbortSignal` cancellation including late
 * chunks after abort, bounded overall/first-token/idle limits, `Retry-After`
 * honoring between attempts, and separately labelled attempts so a retry
 * never silently blends into the previous partial output.
 *
 * One adapter serves every attempt: there is no fallback to another route
 * and approved photos are never forwarded anywhere except inside the same
 * adapter's unchanged request.
 */
import type {
  NormalizedRequest,
  ProviderAdapter,
  StreamEvent,
  StreamPhase,
} from "./providerContract";
import type { InferenceProvenance } from "./orchestrator/provenance";

/**
 * Orchestrator call-site hook (WS-A): when the caller routes through
 * `AiOrchestrator`, it passes its trace/model ids here and receives the
 * terminal provenance context back. Absent by default — coordination
 * behavior is unchanged unless the hook is provided.
 */
export type CoordinatorProvenance = Pick<InferenceProvenance, "traceId" | "modelId">;

export type CoordinatorOptions = {
  /** The single adapter for all attempts. Never replaced mid-flight. */
  readonly adapter: ProviderAdapter;
  /** Bounded attempt count, clamped to 1..5. Defaults to 2. */
  readonly maxAttempts?: number;
  /** Hard bound for the whole operation including retries. Defaults to 120s. */
  readonly overallMs?: number;
  /** Bound for the first text delta of each attempt. Defaults to 30s. */
  readonly firstTokenMs?: number;
  /** Bound for silence between two events of one attempt. Defaults to 60s. */
  readonly idleMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Delay before the next attempt. Defaults to honoring a `retry-after`
   * interval surfaced on the error event, with exponential backoff otherwise.
   */
  readonly getRetryDelayMs?: (
    error: Extract<StreamEvent, { kind: "error" }>,
    attempt: number,
  ) => number;
  readonly onEvent?: (event: StreamEvent) => void;
  /** Orchestrator trace id for the provenance call-site (optional). */
  readonly traceId?: string;
  /** Orchestrator model id for the provenance call-site (optional). */
  readonly modelId?: string;
  /** Terminal provenance hook for the orchestrator call-site (optional). */
  readonly reportProvenance?: (provenance: CoordinatorProvenance) => void;
};

const DEFAULT_OVERALL_MS = 120_000;
const DEFAULT_FIRST_TOKEN_MS = 30_000;
const DEFAULT_IDLE_MS = 60_000;
const MAX_ATTEMPTS = 5;
const RETRY_AFTER_CAP_MS = 60_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Honor a `retry-after <seconds>` interval surfaced on an error event. */
export function parseRetryAfterMs(message: string): number | undefined {
  const match = /retry-after[\s:=]+(\d+)/i.exec(message);
  if (match === null) return undefined;
  const seconds = Number.parseInt(match[1]!, 10);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
}

function defaultRetryDelayMs(
  error: Extract<StreamEvent, { kind: "error" }>,
  attempt: number,
): number {
  return parseRetryAfterMs(error.message) ?? Math.min(1000 * 2 ** (attempt - 1), 10_000);
}

export type TimeoutKind = "timeout-overall" | "timeout-first-token" | "timeout-idle";

/**
 * Consumer copy, one line per guard. The message reaches the transcript, so it
 * explains what happened in plain words — never the internal timing vocabulary
 * ("first-token bound", "provider") that describes how the guard is built. The
 * controller resolves the same map by code for the failure banner, so this
 * stays the single source of that copy.
 */
export const TIMEOUT_ERROR_COPY: Readonly<Record<TimeoutKind, string>> = {
  "timeout-overall": "That answer took too long, so it was stopped. Try again.",
  "timeout-first-token": "The assistant didn't start replying in time. Try again.",
  "timeout-idle": "The assistant stopped replying partway through. Try again.",
};

function timeoutMessage(kind: TimeoutKind): string {
  return TIMEOUT_ERROR_COPY[kind];
}

/** Orchestrator call-site: report terminal provenance context, if wired. */
function reportTerminalProvenance(options: CoordinatorOptions): void {
  const traceId = options.traceId;
  const modelId = options.modelId;
  if (traceId === undefined || traceId.trim() === "") return;
  if (modelId === undefined || modelId.trim() === "") return;
  options.reportProvenance?.({ traceId, modelId });
}

export async function* coordinate(
  request: NormalizedRequest,
  options: CoordinatorOptions,
): AsyncIterable<StreamEvent> {
  const adapter = options.adapter;
  const maxAttempts = Math.min(Math.max(Math.floor(options.maxAttempts ?? 2), 1), MAX_ATTEMPTS);
  const overallMs = options.overallMs ?? DEFAULT_OVERALL_MS;
  const firstTokenMs = options.firstTokenMs ?? DEFAULT_FIRST_TOKEN_MS;
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const sleep = options.sleep ?? defaultSleep;
  const getRetryDelayMs = options.getRetryDelayMs ?? defaultRetryDelayMs;
  const overallDeadline = Date.now() + overallMs;

  /**
   * The coordinator OWNS attempt identity. Every outward event is stamped with
   * the current OUTER attempt, never the adapter's internal number: a provider
   * adapter commonly restarts its own stream at `attempt: 1` on each
   * invocation, so trusting it would let a retry blend into the previous
   * attempt downstream (the failed attempt's text concatenating into the
   * successful one).
   */
  let currentAttempt = 1;

  const emit = function* (event: StreamEvent): Generator<StreamEvent> {
    const normalized: StreamEvent =
      event.attempt === currentAttempt ? event : { ...event, attempt: currentAttempt };
    options.onEvent?.(normalized);
    yield normalized;
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    currentAttempt = attempt;
    if (request.signal.aborted) {
      yield* emit({ kind: "phase", phase: "cancelled", attempt });
      yield* emit({ kind: "done", attempt, stopReason: "cancelled" });
      reportTerminalProvenance(options);
      return;
    }
    const emittedPhases = new Set<StreamPhase>();
    const emitPhase = function* (phase: StreamPhase): Generator<StreamEvent> {
      if (emittedPhases.has(phase)) return;
      emittedPhases.add(phase);
      yield* emit({ kind: "phase", phase, attempt });
    };

    yield* emitPhase("queued");
    yield* emitPhase("sending");

    let seenText = false;
    let streamingAnnounced = false;
    let lastError: Extract<StreamEvent, { kind: "error" }> | undefined;
    let sawDone = false;
    let attemptFailed = false;
    const firstTokenDeadline = Date.now() + firstTokenMs;
    let idleDeadline = Date.now() + idleMs;

    const iterator = adapter.complete(request)[Symbol.asyncIterator]();
    for (;;) {
      if (request.signal.aborted) {
        await closeIterator(iterator);
        yield* emitPhase("cancelled");
        yield* emit({ kind: "done", attempt, stopReason: "cancelled" });
        reportTerminalProvenance(options);
        return;
      }
      const now = Date.now();
      const remainingOverall = overallDeadline - now;
      if (remainingOverall <= 0) {
        lastError = {
          kind: "error",
          attempt,
          code: "timeout-overall",
          message: timeoutMessage("timeout-overall"),
          retryable: false,
        };
        attemptFailed = true;
        break;
      }
      const firstTokenRemaining = seenText ? undefined : firstTokenDeadline - now;
      const idleRemaining = idleDeadline - now;
      let waitMs = Math.min(remainingOverall, idleRemaining);
      let waitKind: TimeoutKind = "timeout-idle";
      if (firstTokenRemaining !== undefined && firstTokenRemaining < waitMs) {
        waitMs = firstTokenRemaining;
        waitKind = "timeout-first-token";
      }
      if (waitMs <= 0) {
        const kind: TimeoutKind =
          waitKind === "timeout-first-token" && (firstTokenDeadline - Date.now() <= 0)
            ? "timeout-first-token"
            : "timeout-idle";
        lastError = {
          kind: "error",
          attempt,
          code: kind,
          message: timeoutMessage(kind),
          retryable: true,
        };
        attemptFailed = true;
        break;
      }

      let next: IteratorResult<StreamEvent>;
      try {
        next = await raceNext(iterator, waitMs);
      } catch {
        lastError = {
          kind: "error",
          attempt,
          code: waitKind,
          message: timeoutMessage(waitKind),
          retryable: true,
        };
        attemptFailed = true;
        break;
      }
      idleDeadline = Date.now() + idleMs;

      if (next.done === true) break;
      const event = next.value;
      // Late chunks after abort never reach the consumer.
      if (request.signal.aborted) {
        await closeIterator(iterator);
        yield* emitPhase("cancelled");
        yield* emit({ kind: "done", attempt, stopReason: "cancelled" });
        reportTerminalProvenance(options);
        return;
      }
      if (event.kind === "phase") {
        // The coordinator owns phase reporting; adapter phases would
        // duplicate it, so only unseen phases pass through.
        yield* emitPhase(event.phase);
        continue;
      }
      if (event.kind === "text") {
        if (!seenText) {
          seenText = true;
          yield* emitPhase("first-token");
        } else if (!streamingAnnounced) {
          streamingAnnounced = true;
          yield* emitPhase("streaming");
        }
        yield* emit(event);
        continue;
      }
      if (event.kind === "error") {
        lastError = event;
        yield* emit(lastError);
        continue;
      }
      if (event.kind === "done") {
        sawDone = true;
        if (event.stopReason === "complete") {
          yield* emitPhase("complete");
        } else if (event.stopReason === "cancelled") {
          yield* emitPhase("cancelled");
        } else {
          attemptFailed = true;
          yield* emitPhase("failed");
        }
        yield* emit(event);
        break;
      }
      yield* emit(event);
    }
    await closeIterator(iterator);

    if (!sawDone) {
      if (attemptFailed && lastError !== undefined) {
        yield* emit(lastError);
      }
      if (attemptFailed) {
        yield* emitPhase("failed");
        yield* emit({ kind: "done", attempt, stopReason: "error" });
      } else {
        yield* emitPhase("complete");
        yield* emit({ kind: "done", attempt, stopReason: "complete" });
        reportTerminalProvenance(options);
        return;
      }
    } else if (!attemptFailed) {
      reportTerminalProvenance(options);
      return;
    }

    const retryable = lastError?.retryable === true;
    if (retryable && attempt < maxAttempts) {
      yield* emitPhase("retrying");
      await sleep(getRetryDelayMs(lastError!, attempt));
      continue;
    }
    reportTerminalProvenance(options);
    return;
  }
}

/** Upper bound for courtesy iterator teardown. A stuck adapter must not stall the consumer. */
const CLOSE_TIMEOUT_MS = 250;

async function closeIterator(iterator: AsyncIterator<StreamEvent>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Best effort only: return() on a generator suspended at an unsettled
    // await (e.g. after a timeout) may never settle, so never wait for it
    // longer than the courtesy bound. Live teardown travels via signal.
    await Promise.race([
      iterator.return?.(),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => resolve(), CLOSE_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // Ignore teardown errors; the consumer already went away.
  } finally {
    clearTimeout(timer);
  }
}

class TimeoutError extends Error {
  constructor() {
    super("coordinator-timeout");
    this.name = "TimeoutError";
  }
}

function raceNext(
  iterator: AsyncIterator<StreamEvent>,
  waitMs: number,
): Promise<IteratorResult<StreamEvent>> {
  return new Promise<IteratorResult<StreamEvent>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError()), waitMs);
    iterator
      .next()
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new TimeoutError());
      });
  });
}
