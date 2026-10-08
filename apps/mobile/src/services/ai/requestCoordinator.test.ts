import { describe, expect, it, vi } from "vitest";
import { coordinate } from "./requestCoordinator";
import type {
  NormalizedRequest,
  ProviderAdapter,
  StreamEvent,
} from "./providerContract";

function requestWithSignal(signal: AbortSignal): NormalizedRequest {
  return {
    selection: {
      accountId: "acct-1",
      provider: "openrouter",
      modelId: "openrouter/free",
      mode: "free-only",
    },
    task: "general",
    policyVersion: "policy-7",
    knowledgeVersion: "kb-1",
    recentTurns: [],
    currentText: "Hello",
    approvedImageIds: ["img-1"],
    authorizedResultIds: [],
    maxOutputTokens: 600,
    signal,
  };
}

function adapterFor(runs: Array<StreamEvent[]>): ProviderAdapter & { calls: NormalizedRequest[] } {
  const calls: NormalizedRequest[] = [];
  let index = 0;
  const adapter: ProviderAdapter & { calls: NormalizedRequest[] } = {
    id: "openrouter",
    capabilities: () => ({
      vision: { state: "unknown" },
      maxImagesPerCall: { state: "unknown" },
      contextTokens: { state: "unknown" },
      maxOutputTokens: { state: "unknown" },
      streaming: { state: "known", value: true },
    }),
    calls,
    async *complete(request: NormalizedRequest): AsyncIterable<StreamEvent> {
      calls.push(request);
      const script = runs[Math.min(index, runs.length - 1)]!;
      index += 1;
      for (const event of script) yield event;
    },
  };
  return adapter;
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function textOf(events: StreamEvent[], attempt: number): string {
  return events
    .filter((event) => event.kind === "text" && event.attempt === attempt)
    .map((event) => (event.kind === "text" ? event.delta : ""))
    .join("");
}

describe("requestCoordinator orchestration", () => {
  it("streams success through observable phases with attempt labels", async () => {
    const adapter = adapterFor([
      [
        { kind: "phase", phase: "queued", attempt: 1 },
        { kind: "phase", phase: "sending", attempt: 1 },
        { kind: "text", attempt: 1, delta: "Hello " },
        { kind: "text", attempt: 1, delta: "there" },
        { kind: "usage", attempt: 1, inputTokens: 10, outputTokens: 4 },
        { kind: "done", attempt: 1, stopReason: "complete" },
      ],
    ]);
    const events = await collect(
      coordinate(requestWithSignal(new AbortController().signal), { adapter }),
    );
    const phases = events.filter((event) => event.kind === "phase").map((event) => (event.kind === "phase" ? event.phase : ""));
    expect(phases).toEqual(["queued", "sending", "first-token", "streaming", "complete"]);
    expect(textOf(events, 1)).toBe("Hello there");
    const usage = events.filter((event) => event.kind === "usage");
    expect(usage).toEqual([{ kind: "usage", attempt: 1, inputTokens: 10, outputTokens: 4 }]);
    expect(adapter.calls).toHaveLength(1);
  });

  it("retries a retryable 503 failure as a separately labelled new attempt", async () => {
    const adapter = adapterFor([
      [
        { kind: "text", attempt: 1, delta: "partial-" },
        { kind: "error", attempt: 1, code: "provider-error", message: "HTTP 503 upstream", retryable: true },
        { kind: "done", attempt: 1, stopReason: "error" },
      ],
      [
        { kind: "text", attempt: 2, delta: "fresh" },
        { kind: "usage", attempt: 2, inputTokens: 12, outputTokens: 2 },
        { kind: "done", attempt: 2, stopReason: "complete" },
      ],
    ]);
    const events = await collect(
      coordinate(requestWithSignal(new AbortController().signal), {
        adapter,
        maxAttempts: 2,
        sleep: async () => undefined,
      }),
    );
    // Same adapter object serves both attempts: no hidden fallback, no reroute.
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[0]!.approvedImageIds).toEqual(["img-1"]);
    expect(adapter.calls[1]!.approvedImageIds).toEqual(["img-1"]);
    // Partials stay separately attributable instead of blending.
    expect(textOf(events, 1)).toBe("partial-");
    expect(textOf(events, 2)).toBe("fresh");
    const phases = events.filter((event) => event.kind === "phase");
    expect(phases.some((event) => event.kind === "phase" && event.phase === "retrying" && event.attempt === 1)).toBe(true);
    expect(phases.some((event) => event.kind === "phase" && event.phase === "complete" && event.attempt === 2)).toBe(true);
  });

  it("stops retrying on non-retryable errors such as refusals", async () => {
    const adapter = adapterFor([
      [
        { kind: "error", attempt: 1, code: "refused", message: "refused", retryable: false },
        { kind: "done", attempt: 1, stopReason: "error" },
      ],
    ]);
    const events = await collect(
      coordinate(requestWithSignal(new AbortController().signal), {
        adapter,
        maxAttempts: 3,
        sleep: async () => undefined,
      }),
    );
    expect(adapter.calls).toHaveLength(1);
    expect(events.some((event) => event.kind === "phase" && event.phase === "failed")).toBe(true);
  });

  it("honours Retry-After delays between attempts", async () => {
    const adapter = adapterFor([
      [
        { kind: "error", attempt: 1, code: "rate-limited", message: "slow down; retry-after 2", retryable: true },
        { kind: "done", attempt: 1, stopReason: "error" },
      ],
      [{ kind: "done", attempt: 2, stopReason: "complete" }],
    ]);
    const sleep = vi.fn(async () => undefined);
    await collect(
      coordinate(requestWithSignal(new AbortController().signal), { adapter, maxAttempts: 2, sleep }),
    );
    expect(sleep).toHaveBeenCalledTimes(1);
    const delays = sleep.mock.calls as unknown as Array<[number]>;
    expect(delays[0]?.[0]).toBe(2000);
  });

  it("cancels mid-stream and ignores late chunks after abort", async () => {
    const controller = new AbortController();
    const adapter: ProviderAdapter = {
      id: "openrouter",
      capabilities: () => ({
        vision: { state: "unknown" },
        maxImagesPerCall: { state: "unknown" },
        contextTokens: { state: "unknown" },
        maxOutputTokens: { state: "unknown" },
        streaming: { state: "known", value: true },
      }),
      async *complete(): AsyncIterable<StreamEvent> {
        yield { kind: "text", attempt: 1, delta: "first" };
        controller.abort();
        // Late chunks after abort must never reach the consumer.
        yield { kind: "text", attempt: 1, delta: "late" };
        yield { kind: "usage", attempt: 1, inputTokens: 99, outputTokens: 99 };
        yield { kind: "done", attempt: 1, stopReason: "complete" };
      },
    };
    const events = await collect(coordinate(requestWithSignal(controller.signal), { adapter }));
    expect(textOf(events, 1)).toBe("first");
    expect(events.some((event) => event.kind === "usage")).toBe(false);
    expect(events[events.length - 1]).toEqual({ kind: "done", attempt: 1, stopReason: "cancelled" });
    expect(events.some((event) => event.kind === "phase" && event.phase === "cancelled")).toBe(true);
  });

  it("fails fast when the first token never arrives", async () => {
    const hanging: ProviderAdapter = {
      id: "openrouter",
      capabilities: () => ({
        vision: { state: "unknown" },
        maxImagesPerCall: { state: "unknown" },
        contextTokens: { state: "unknown" },
        maxOutputTokens: { state: "unknown" },
        streaming: { state: "known", value: true },
      }),
      async *complete(): AsyncIterable<StreamEvent> {
        await new Promise<never>(() => undefined);
        yield { kind: "done", attempt: 1, stopReason: "complete" };
      },
    };
    const events = await collect(
      coordinate(requestWithSignal(new AbortController().signal), {
        adapter: hanging,
        maxAttempts: 1,
        firstTokenMs: 20,
        sleep: async () => undefined,
      }),
    );
    const errors = events.filter((event) => event.kind === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatchObject({ code: "timeout-first-token" });
  });

  it("accounts usage separately per attempt", async () => {
    const adapter = adapterFor([
      [
        { kind: "usage", attempt: 1, inputTokens: 100, outputTokens: 10 },
        { kind: "error", attempt: 1, code: "provider-error", message: "HTTP 503", retryable: true },
        { kind: "done", attempt: 1, stopReason: "error" },
      ],
      [
        { kind: "usage", attempt: 2, inputTokens: 100, outputTokens: 5 },
        { kind: "done", attempt: 2, stopReason: "complete" },
      ],
    ]);
    const events = await collect(
      coordinate(requestWithSignal(new AbortController().signal), {
        adapter,
        maxAttempts: 2,
        sleep: async () => undefined,
      }),
    );
    expect(events.filter((event) => event.kind === "usage")).toEqual([
      { kind: "usage", attempt: 1, inputTokens: 100, outputTokens: 10 },
      { kind: "usage", attempt: 2, inputTokens: 100, outputTokens: 5 },
    ]);
  });

  it("normalizes EVERY outward event to the outer attempt, ignoring adapter-internal numbering", async () => {
    // A real adapter commonly restarts its own stream at attempt=1 on every
    // invocation. Trusting that number would let a retry blend into the
    // previous attempt downstream, so the coordinator must re-stamp text,
    // usage, phase, error and done with its own outer attempt.
    const adapter = adapterFor([
      [
        { kind: "phase", phase: "queued", attempt: 1 },
        { kind: "text", attempt: 1, delta: "partial-" },
        { kind: "usage", attempt: 1, inputTokens: 5, outputTokens: 1 },
        { kind: "error", attempt: 1, code: "provider-error", message: "HTTP 503 retry-after 0", retryable: true },
        { kind: "done", attempt: 1, stopReason: "error" },
      ],
      [
        { kind: "phase", phase: "queued", attempt: 1 },
        { kind: "text", attempt: 1, delta: "fresh" },
        { kind: "usage", attempt: 1, inputTokens: 7, outputTokens: 2 },
        { kind: "done", attempt: 1, stopReason: "complete" },
      ],
    ]);
    const events = await collect(
      coordinate(requestWithSignal(new AbortController().signal), {
        adapter,
        maxAttempts: 2,
        sleep: async () => undefined,
      }),
    );
    // The second invocation's events are labelled attempt 2, not 1.
    expect(textOf(events, 1)).toBe("partial-");
    expect(textOf(events, 2)).toBe("fresh");
    expect(events.filter((event) => event.kind === "text").map((event) => event.attempt)).toEqual([1, 2]);
    expect(events.filter((event) => event.kind === "usage").map((event) => event.attempt)).toEqual([1, 2]);
    expect(events.filter((event) => event.kind === "error").map((event) => event.attempt)).toEqual([1]);
    expect(events.filter((event) => event.kind === "done").map((event) => event.attempt)).toEqual([1, 2]);
    // No event may keep the adapter's stale attempt=1 after the retry began.
    const afterRetry = events.slice(events.findIndex((event) => event.kind === "phase" && event.phase === "retrying"));
    expect(afterRetry.every((event) => event.attempt >= 1)).toBe(true);
    expect(afterRetry.some((event) => event.attempt === 2)).toBe(true);
  });
});
