import { afterEach, describe, expect, it, vi } from "vitest";
import { formatEventDate, isFutureDate, timeAgo, todayInputValue } from "../utils/dates";

describe("dates util", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("defaults to the server UTC day even when the local day is yesterday", () => {
    vi.stubEnv("TZ", "Pacific/Honolulu");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T01:00:00Z"));

    expect(todayInputValue()).toBe("2026-09-26");
  });

  it("accepts UTC today even when the local day is yesterday", () => {
    vi.stubEnv("TZ", "Pacific/Honolulu");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T01:00:00Z"));

    expect(isFutureDate("2026-09-26")).toBe(false);
  });

  it("defaults to the server UTC day even when the local day is tomorrow", () => {
    vi.stubEnv("TZ", "Pacific/Kiritimati");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T23:30:00Z"));

    expect(todayInputValue()).toBe("2026-09-25");
  });

  it("rejects UTC tomorrow even when the local day is already tomorrow", () => {
    vi.stubEnv("TZ", "Pacific/Kiritimati");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T23:30:00Z"));

    expect(isFutureDate("2026-09-26")).toBe(true);
    expect(isFutureDate("2026-09-25")).toBe(false);
  });

  it("formats an event date", () => {
    const out = formatEventDate("2026-09-09");
    expect(out).toMatch(/Sep/);
    expect(out).toMatch(/2026/);
  });

  it("returns the input unchanged when unparseable", () => {
    expect(formatEventDate("not-a-date")).toBe("not-a-date");
  });

  it("returns a dash for empty input", () => {
    expect(formatEventDate("")).toBe("—");
  });

  it("renders relative time buckets", () => {
    const now = Date.now();
    expect(timeAgo(new Date(now - 30_000).toISOString())).toBe("just now");
    expect(timeAgo(new Date(now - 5 * 60_000).toISOString())).toBe("5m ago");
    expect(timeAgo(new Date(now - 2 * 3_600_000).toISOString())).toBe("2h ago");
    expect(timeAgo(new Date(now - 3 * 86_400_000).toISOString())).toBe("3d ago");
  });

  it("produces a YYYY-MM-DD input value for today", () => {
    const v = todayInputValue();
    expect(v).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("flags future dates", () => {
    expect(isFutureDate("2999-01-01")).toBe(true);
  });

  it("accepts today and past dates", () => {
    expect(isFutureDate(todayInputValue())).toBe(false);
    expect(isFutureDate("2020-01-01")).toBe(false);
  });

  it("treats empty or unparseable input as not future", () => {
    expect(isFutureDate("")).toBe(false);
    expect(isFutureDate("not-a-date")).toBe(false);
  });
});
