import { describe, expect, it } from "vitest";
import { formatEventDate, isFutureDate, timeAgo, todayInputValue } from "../utils/dates";

describe("dates util", () => {
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
