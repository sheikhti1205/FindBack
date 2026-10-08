import { afterEach, describe, expect, it, vi } from "vitest";
import { clearDiagEvents, getDiagEvents, setDiagEnabled } from "../diag";
import { createStreamingPaint } from "./streamingPaint";

afterEach(() => { vi.useRealTimers(); setDiagEnabled(false); clearDiagEvents(); });

describe("generation-scoped streaming paint", () => {
  it("paints during a sustained 10ms stream instead of resetting its deadline", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const paints: { text: string; ms: number }[] = [];
    const scheduler = createStreamingPaint({ paint: text => paints.push({ text, ms: Date.now() }), now: () => Date.now() });
    let text = "";
    for (let ms = 0; ms < 300; ms += 10) {
      text += "x";
      scheduler.push(text);
      vi.advanceTimersByTime(10);
    }
    expect(paints.length).toBeGreaterThanOrEqual(5);
    expect(paints.length).toBeLessThan(15);
    expect(paints[0]?.text).toBe("x");
    expect(paints.slice(1).every((p, i) => p.ms - paints[i]!.ms <= 80)).toBe(true);
    scheduler.flush();
    expect(paints.at(-1)?.text).toBe(text);
  });

  it("paints sparse arrivals immediately and newline boundaries without waiting for quiet", () => {
    vi.useFakeTimers();
    const paints: string[] = [];
    let ms = 0;
    const scheduler = createStreamingPaint({ paint: text => paints.push(text), now: () => ms });
    scheduler.push("First");
    ms = 150; vi.advanceTimersByTime(150);
    scheduler.push("First sparse");
    expect(paints).toEqual(["First", "First sparse"]);
    ms = 180; vi.advanceTimersByTime(30);
    scheduler.push("First sparse\n");
    expect(paints.at(-1)).toBe("First sparse\n");
  });

  it("flushes the latest cumulative text exactly once and seals completion against late chunks", () => {
    vi.useFakeTimers();
    const paints: string[] = [];
    const scheduler = createStreamingPaint({ paint: text => paints.push(text), now: () => 0 });
    scheduler.push("a"); scheduler.push("ab"); scheduler.push("ab");
    scheduler.flush(); scheduler.flush(); scheduler.push("stale");
    vi.runAllTimers();
    expect(paints).toEqual(["a", "ab"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("discards cancelled work without clearing or resurrecting the next generation", () => {
    vi.useFakeTimers();
    const paints: string[] = [];
    const old = createStreamingPaint({ paint: text => paints.push(text), now: () => 0 });
    old.push("old"); old.push("old pending"); old.cancel();
    paints.length = 0; // Help clears the terminal partial itself.
    const next = createStreamingPaint({ paint: text => paints.push(text), now: () => 0 });
    next.push("new"); old.push("late old"); old.flush(); vi.runAllTimers();
    expect(paints).toEqual(["new"]);
  });

  it("records only numeric cadence fields, never cumulative text or private identifiers", () => {
    vi.useFakeTimers(); setDiagEnabled(true);
    let ms = 0;
    const scheduler = createStreamingPaint({ paint: () => {}, now: () => ms });
    scheduler.push("private person photo data"); ms = 40;
    scheduler.push("private person photo data continued"); scheduler.flush();
    const events = getDiagEvents().filter(e => e.event.startsWith("ai.stream.paint"));
    expect(events.length).toBeGreaterThan(0);
    expect(events.at(-1)?.fields.chunkCount).toBe(2);
    expect(events.at(-1)?.fields.paintCount).toBe(2);
    expect(events.every(e => Object.values(e.fields).every(v => typeof v === "number"))).toBe(true);
    expect(JSON.stringify(events)).not.toContain("private person");
  });

  it("uses real timers to deliver pending content while the producer is still active", async () => {
    const paints: string[] = [];
    const scheduler = createStreamingPaint({ paint: text => paints.push(text) });
    scheduler.push("a"); scheduler.push("ab");
    await vi.waitFor(() => expect(paints).toContain("ab"), { timeout: 1000, interval: 10 });
    scheduler.cancel();
  });
});
