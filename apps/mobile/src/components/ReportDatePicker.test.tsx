// @vitest-environment jsdom
import type { FormEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReportDatePicker } from "./ReportDatePicker";
import { todayInputValue } from "../utils/dates";
import { resetLocalTimeZone, setLocalTimeZone } from "@internationalized/date";

afterEach(() => {
  cleanup();
});

describe("ReportDatePicker", () => {
  const onChange = vi.fn();

  afterEach(() => {
    onChange.mockClear();
  });

  /**
   * Step the calendar to the target month by reading the visible heading —
   * never a hardcoded click count, which drifts as the current month changes
   * (and outside-month filler days would otherwise let assertions pass on the
   * wrong month). Fails loudly if the heading never arrives.
   */
  async function goToMonthHeading(target: RegExp, direction: "prev" | "next"): Promise<void> {
    const button = screen.getByRole("button", {
      name: direction === "prev" ? /previous month/i : /next month/i,
    });
    for (let i = 0; i < 14; i++) {
      if (screen.queryByRole("heading", { name: target })) return;
      fireEvent.click(button);
      await waitFor(() => {});
    }
    expect(screen.getByRole("heading", { name: target })).toBeTruthy();
  }

  it("renders trigger with formatted date when value is provided", () => {
    render(<ReportDatePicker value="2026-09-26" onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: /date of event/i });
    expect(trigger).toBeTruthy();
    expect(trigger.textContent).toMatch(/Sep 26, 2026/i);
  });

  it("renders trigger with placeholder when value is empty", () => {
    render(<ReportDatePicker value="" onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: /date of event/i });
    expect(trigger.textContent).toBe("Select date");
  });

  it("shows error message and sets aria-invalid when error prop is provided", () => {
    render(<ReportDatePicker value="2026-09-26" onChange={onChange} error="Date is required" />);
    const trigger = screen.getByRole("button", { name: /date of event/i });
    expect(trigger.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toBe("Date is required");
  });

  it("opens sheet on trigger click", async () => {
    render(<ReportDatePicker value="2026-09-26" onChange={onChange} expected="LOST" />);
    const trigger = screen.getByRole("button", { name: /date of event/i });
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: /when was it lost\?/i })).toBeTruthy();
    });
  });

  it("sheet title reflects expected event type", async () => {
    render(<ReportDatePicker value="2026-09-26" onChange={onChange} expected="FOUND" />);
    const trigger = screen.getByRole("button", { name: /date of event/i });
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: /when was it found\?/i })).toBeTruthy();
    });
  });

  it("opens with the passed value selected in calendar", async () => {
    render(<ReportDatePicker value="2026-09-26" onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: /date of event/i });
    fireEvent.click(trigger);
    await waitFor(() => {
      const selectedCell = screen.getByRole("button", { name: /26.*selected/i });
      expect(selectedCell).toBeTruthy();
    });
  });

  it("shows the displayed month and year as a visible accessible heading while navigating", async () => {
    render(<ReportDatePicker value="2024-02-29" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /date of event/i }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());

    const february = screen.getByRole("heading", { name: /February 2024/i });
    // React Aria announces the month through a visually hidden heading and
    // hides the visible copy from assistive tech to avoid double announcement.
    expect(screen.getByRole("dialog").querySelector("header h2")?.textContent).toBe(february.textContent);
    fireEvent.click(screen.getByRole("button", { name: /previous month/i }));
    await waitFor(() => {
      const january = screen.getByRole("heading", { name: /January 2024/i });
      expect(screen.getByRole("dialog").querySelector("header h2")?.textContent).toBe(january.textContent);
    });
  });

  it("commits value on Confirm click", async () => {
    render(<ReportDatePicker value="2026-09-26" onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: /date of event/i });
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
    });

    const confirmButton = screen.getByRole("button", { name: /confirm/i });
    fireEvent.click(confirmButton);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("2026-09-26");
  });

  it("does not commit value on Cancel click", async () => {
    render(<ReportDatePicker value="2026-09-26" onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: /date of event/i });
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
    });

    const cancelButton = screen.getByRole("button", { name: /cancel/i });
    fireEvent.click(cancelButton);

    expect(onChange).not.toHaveBeenCalled();
  });

  it("discards an unconfirmed selection when an empty date picker is reopened", async () => {
    render(<ReportDatePicker value="" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /date of event/i }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /^today$/i }));
    expect((screen.getByRole("button", { name: /confirm/i }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    fireEvent.click(screen.getByRole("button", { name: /date of event/i }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());

    expect((screen.getByRole("button", { name: /confirm/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not commit value when pressing Escape", async () => {
    render(<ReportDatePicker value="2026-09-26" onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: /date of event/i });
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
    });

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("navigating month does not change value until Confirm", async () => {
    render(<ReportDatePicker value="2026-09-26" onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: /date of event/i });
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
    });

    // Click next month button
    const nextButton = screen.getByRole("button", { name: /next month/i });
    fireEvent.click(nextButton);

    // Click Confirm - should commit the newly selected date (not the original)
    // But since we didn't select a new day, the displayed value should still be the original
    const confirmButton = screen.getByRole("button", { name: /confirm/i });
    fireEvent.click(confirmButton);

    // Value should remain unchanged since no new day was selected
    expect(onChange).toHaveBeenCalledWith("2026-09-26");
  });

  it("selecting a new day and confirming commits the new value", async () => {
    render(<ReportDatePicker value="2026-09-26" onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: /date of event/i });
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
    });

    // Click on a different day (25th - past date, not future)
    const day25 = screen.getByRole("button", { name: /Friday, September 25, 2026/i });
    fireEvent.click(day25);

    const confirmButton = screen.getByRole("button", { name: /confirm/i });
    fireEvent.click(confirmButton);

    expect(onChange).toHaveBeenCalledWith("2026-09-25");
  });

  it("future dates in current month are not selectable", async () => {
    render(<ReportDatePicker value="" onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: /date of event/i });
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
    });

    // Tomorrow (UTC) must be disabled regardless of when the suite runs.
    const tomorrow = new Date(`${todayInputValue()}T00:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const label = tomorrow.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
    const futureCell = screen.getByRole("button", { name: new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") });
    expect(futureCell.getAttribute("aria-disabled")).toBe("true");
  });

  it("today button sets displayed value to today (UTC)", async () => {
    render(<ReportDatePicker value="2026-09-25" onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: /date of event/i });
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
    });

    // Target the "Today" button in the footer (not the calendar day cell)
    const todayButton = screen.getByRole("button", { name: /^today$/i });
    fireEvent.click(todayButton);

    // The calendar should show today (UTC) as selected
    const todayIso = todayInputValue();
    const todayLabel = new Date(`${todayIso}T00:00:00Z`).toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
    const todayCell = screen.getByRole(
      "button",
      { name: new RegExp(`${todayLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} selected`, "i") },
    );
    expect(todayCell.getAttribute("data-selected")).toBe("true");
    // Confirm should be enabled since today (UTC) is not a future date
    const confirmButton = screen.getByRole("button", { name: /confirm/i });
    expect((confirmButton as HTMLButtonElement).disabled).toBe(false);
  });

  it("value round-trips exactly as ISO date-only", async () => {
    const testDates = ["2026-09-26", "2024-02-29", "2024-01-01", "2025-12-31"];

    for (const date of testDates) {
      onChange.mockClear();
      render(<ReportDatePicker value={date} onChange={onChange} />);
      const trigger = screen.getByRole("button", { name: /date of event/i });
      fireEvent.click(trigger);
      await waitFor(() => {
        expect(screen.getByRole("dialog")).toBeTruthy();
      });

      const confirmButton = screen.getByRole("button", { name: /confirm/i });
      fireEvent.click(confirmButton);

      expect(onChange).toHaveBeenCalledWith(date);
      cleanup();
    }
  });

  it("accepts 2024-02-29 (leap year)", async () => {
    render(<ReportDatePicker value="2024-02-29" onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: /date of event/i });
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
    });

    const confirmButton = screen.getByRole("button", { name: /confirm/i });
    fireEvent.click(confirmButton);

    expect(onChange).toHaveBeenCalledWith("2024-02-29");
  });

  it("rejects 2026-02-29 (non-leap year) - date not selectable", async () => {
    // 2026-02-29 doesn't exist, so it can't be selected in the calendar.
    // Navigate by the visible month heading (never a hardcoded click count,
    // which drifts as the current month changes).
    render(<ReportDatePicker value="" onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: /date of event/i });
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
    });

    await goToMonthHeading(/February 2026/i, "prev");

    // The calendar should show 28 days in February 2026
    const feb28Cell = screen.getByRole("button", { name: /February 28, 2026/i });
    expect(feb28Cell).toBeTruthy();

    // There should be no 29th
    expect(screen.queryByRole("button", { name: /February 29, 2026/i })).toBeFalsy();
  });

  it("rejects 2026-04-31 (invalid day overflow)", async () => {
    // April has 30 days, so 31st should not exist. Navigate by the visible
    // month heading (never a hardcoded click count, which drifts as the
    // current month changes — and outside-month filler days would otherwise
    // make this pass vacuously on the wrong month).
    render(<ReportDatePicker value="" onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: /date of event/i });
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
    });

    await goToMonthHeading(/April 2026/i, "prev");

    // Should only show 30 days
    const apr30Cell = screen.getByRole("button", { name: /April 30, 2026/i });
    expect(apr30Cell).toBeTruthy();

    expect(screen.queryByRole("button", { name: /April 31, 2026/i })).toBeFalsy();
  });

  it("future dates are not committable even if tampered", async () => {
    render(<ReportDatePicker value="" onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: /date of event/i });
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
    });

    // Future dates in current month should be disabled
    const tomorrow = new Date(`${todayInputValue()}T00:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const label = tomorrow.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
    const futureCell = screen.getByRole("button", { name: new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") });
    expect(futureCell.getAttribute("aria-disabled")).toBe("true");

    // Confirm button should be disabled when no valid date is selected
    const confirmButton = screen.getByRole("button", { name: /confirm/i });
    expect((confirmButton as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not commit a future date supplied by the parent", async () => {
    const tomorrow = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString().slice(0, 10);
    render(<ReportDatePicker value={tomorrow} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /date of event/i }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());

    const confirm = screen.getByRole("button", { name: /confirm/i });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(confirm);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keyboard navigation: arrows move day selection", async () => {
    render(<ReportDatePicker value="2026-09-26" onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: /date of event/i });
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
    });

    const grid = screen.getByRole("grid");
    const day26 = screen.getByRole("button", { name: /26.*selected/i });
    expect(day26).toBeTruthy();

    // Press left arrow to move to 25th (previous day, since 27 is future)
    fireEvent.keyDown(grid, { key: "ArrowLeft" });

    // Focused day has tabindex="0"
    const day25 = screen.getByRole("button", { name: /Friday, September 25, 2026/i });
    expect(day25.getAttribute("tabindex")).toBe("0");
  });

  it("keyboard navigation: PageUp/PageDown changes month", async () => {
    render(<ReportDatePicker value="2026-09-26" onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: /date of event/i });
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
    });

    const grid = screen.getByRole("grid");

    // Press PageUp to go to previous month (August)
    fireEvent.keyDown(grid, { key: "PageUp" });

    // Should now show August 2026 in the heading
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /August 2026/i })).toBeTruthy();
    });
  });

  it("keyboard: Enter selects focused day", async () => {
    render(<ReportDatePicker value="2026-09-26" onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: /date of event/i });
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
    });

    const grid = screen.getByRole("grid");

    // Navigate to 25th with arrow left (27 is future/disabled)
    fireEvent.keyDown(grid, { key: "ArrowLeft" });

    // Press Enter to select
    fireEvent.keyDown(grid, { key: "Enter" });

    const day25 = screen.getByRole("button", { name: /25.*selected/i });
    expect(day25).toBeTruthy();
  });

  it("keyboard: Escape closes without committing", async () => {
    render(<ReportDatePicker value="2026-09-26" onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: /date of event/i });
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
    });

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeFalsy();
    });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("passes through aria-describedby", () => {
    render(
      <ReportDatePicker
        value="2026-09-26"
        onChange={onChange}
        aria-describedby="external-hint"
      />
    );
    const trigger = screen.getByRole("button", { name: /date of event/i });
    expect(trigger.getAttribute("aria-describedby")).toContain("external-hint");
  });

  it("passes through custom id", () => {
    render(<ReportDatePicker value="2026-09-26" onChange={onChange} id="custom-date-picker" />);
    const trigger = screen.getByRole("button", { name: /date of event/i });
    expect(trigger.getAttribute("id")).toBe("custom-date-picker");
  });

  it("keyboard: Enter on the closed trigger opens the sheet instead of committing", async () => {
    render(<ReportDatePicker value="2026-09-20" onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: /date of event/i });
    fireEvent.keyDown(trigger, { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("caps the latest selectable day at the server UTC date, not the local date", async () => {
    // 2026-09-26 01:00 in Bangladesh (UTC+6) is still 2026-09-25 in UTC.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-09-26T01:00:00+06:00"));
    try {
      render(<ReportDatePicker value="2026-09-25" onChange={onChange} />);
      fireEvent.click(screen.getByRole("button", { name: /date of event/i }));
      await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
      // UTC today (25th) is selectable; the local day (26th) would be rejected
      // by the server and must therefore be disabled.
      expect(
        screen.getByRole("button", { name: /September 25, 2026/i }).getAttribute("aria-disabled"),
      ).not.toBe("true");
      expect(
        screen.getByRole("button", { name: /September 26, 2026/i }).getAttribute("aria-disabled"),
      ).toBe("true");
      // Unmount and drain framer-motion's frame loop on the fake clock:
      // restoring real timers with a frame pending freezes every animation
      // mounted later in this file (rAF callbacks are dropped on restore).
      cleanup();
      await vi.advanceTimersByTimeAsync(1000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never submits a parent form when Today, Cancel or Confirm are pressed", async () => {
    const onSubmit = vi.fn((e: FormEvent) => e.preventDefault());
    const handleChange = vi.fn();
    render(
      <form onSubmit={onSubmit}>
        <ReportDatePicker value="2026-09-25" onChange={handleChange} />
      </form>,
    );
    fireEvent.click(screen.getByRole("button", { name: /date of event/i }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());

    // Every sheet control must be a plain button: inside a parent <form> a
    // missing type would submit the whole report on Today/Cancel/Confirm.
    for (const name of [/^today$/i, /^cancel$/i, /^confirm$/i]) {
      expect(screen.getByRole("button", { name }).getAttribute("type")).toBe("button");
    }

    fireEvent.click(screen.getByRole("button", { name: /^today$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(handleChange).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /date of event/i }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  function swipe(zone: HTMLElement, fromX: number, toX: number, fromY = 300, toY = 302) {
    fireEvent.touchStart(zone, { touches: [{ clientX: fromX, clientY: fromY }] });
    fireEvent.touchEnd(zone, { changedTouches: [{ clientX: toX, clientY: toY }] });
  }

  async function openSheet(value: string) {
    render(<ReportDatePicker value={value} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /date of event/i }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    return screen.getByTestId("calendar-swipe-zone");
  }

  it("swiping left on the grid advances one month without committing", async () => {
    // August 2026 is a past month, so the forward swipe has somewhere to go.
    const zone = await openSheet("2026-08-15");
    swipe(zone, 220, 100);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /September 2026/i })).toBeTruthy();
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("swiping right on the grid goes back one month", async () => {
    const zone = await openSheet("2026-09-26");
    swipe(zone, 100, 220);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /August 2026/i })).toBeTruthy();
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a vertical drag on the grid does not change the month", async () => {
    const zone = await openSheet("2026-09-26");
    fireEvent.touchStart(zone, { touches: [{ clientX: 150, clientY: 100 }] });
    fireEvent.touchEnd(zone, { changedTouches: [{ clientX: 155, clientY: 260 }] });
    expect(screen.getByRole("heading", { name: /September 2026/i })).toBeTruthy();
  });

  it("a short drag on the grid does not change the month", async () => {
    const zone = await openSheet("2026-09-26");
    swipe(zone, 150, 130);
    expect(screen.getByRole("heading", { name: /September 2026/i })).toBeTruthy();
  });

  it("swiping toward a forbidden future month is a no-op", async () => {
    // Viewing the current UTC month: the header next button is disabled by
    // maxValue, so a forward swipe must leave the visible month untouched.
    const zone = await openSheet(todayInputValue());
    const before = screen.getByRole("dialog").querySelector("header h2")?.textContent;
    expect((screen.getByRole("button", { name: /next month/i }) as HTMLButtonElement).disabled).toBe(true);
    swipe(zone, 220, 100);
    expect(screen.getByRole("dialog").querySelector("header h2")?.textContent).toBe(before);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a day tapped in the wake of a swipe is not selected", async () => {
    const zone = await openSheet("2026-09-26");
    // The synthetic click represents the swipe's immediate follow-up, even
    // when full-suite CPU load delays the test beyond the 400ms guard window.
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      swipe(zone, 100, 220);
      await waitFor(() => {
        expect(screen.getByRole("heading", { name: /August 2026/i })).toBeTruthy();
      });
      fireEvent.click(screen.getByRole("button", { name: /Thursday, August 20, 2026/i }));
      fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith("2026-09-26");
    } finally {
      clock.mockRestore();
    }
  });

  it("a day tapped without a preceding swipe still selects", async () => {
    await openSheet("2026-09-26");
    fireEvent.click(screen.getByRole("button", { name: /previous month/i }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /August 2026/i })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: /Thursday, August 20, 2026/i }));
    fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
    expect(onChange).toHaveBeenCalledWith("2026-08-20");
  });

  it("opens an empty calendar on the server UTC month when local time is in the next month", async () => {
    vi.stubEnv("TZ", "Pacific/Kiritimati");
    setLocalTimeZone("Pacific/Kiritimati");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-09-30T23:30:00Z"));
    try {
      expect(todayInputValue()).toBe("2026-09-30");
      render(<ReportDatePicker value="" onChange={onChange} />);
      fireEvent.click(screen.getByRole("button", { name: /date of event/i }));
      await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());

      expect(screen.getByRole("heading", { name: /September 2026/i })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /^today$/i }));
      fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
      expect(onChange).toHaveBeenCalledWith("2026-09-30");
      // Same frame-loop drain as above: never restore real timers with a
      // framer-motion frame pending.
      cleanup();
      await vi.advanceTimersByTimeAsync(1000);
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
      resetLocalTimeZone();
    }
  });

  /** Horizontal travel written by Motion, or 0 when the element is at rest. */
  function travelX(el: HTMLElement): number {
    const match = el.style.transform.match(/translateX\((-?[\d.]+)px\)/);
    return match ? Number.parseFloat(match[1] ?? "0") : 0;
  }

  function atRest(el: HTMLElement): boolean {
    return el.style.transform === "" || el.style.transform === "none";
  }

  it("fades the calendar surface in when the sheet opens", async () => {
    render(<ReportDatePicker value="2026-09-26" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /date of event/i }));
    const surface = screen.getByTestId("calendar-surface");
    // The entrance starts hidden in the very commit that mounts the sheet.
    expect(surface.style.opacity).toBe("0");
    await waitFor(() => expect(surface.style.opacity).toBe("1"));
    expect(atRest(surface)).toBe(true);
    // Content is live while it fades: the selected day is already reachable.
    expect(screen.getByRole("button", { name: /26.*selected/i })).toBeTruthy();
  });

  it("travels one month in the direction of the header button", async () => {
    await openSheet("2026-09-26");
    const month = screen.getByTestId("calendar-month");

    // Backwards first: September is the latest month before the UTC cap.
    fireEvent.click(screen.getByRole("button", { name: /previous month/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /August 2026/i })).toBeTruthy());
    await waitFor(() => expect(travelX(month)).toBeLessThan(0));
    await waitFor(() => expect(atRest(month)).toBe(true));

    // Forwards: the month enters from the trailing edge, then settles.
    fireEvent.click(screen.getByRole("button", { name: /next month/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /September 2026/i })).toBeTruthy());
    await waitFor(() => expect(travelX(month)).toBeGreaterThan(0));
    await waitFor(() => expect(atRest(month)).toBe(true));
  });

  it("swiping a month travels the same way as tapping the header", async () => {
    const zone = await openSheet("2026-08-15");
    const month = screen.getByTestId("calendar-month");
    swipe(zone, 220, 100);
    await waitFor(() => expect(screen.getByRole("heading", { name: /September 2026/i })).toBeTruthy());
    // Forward swipe = forward travel (it drives the same next button).
    await waitFor(() => expect(travelX(month)).toBeGreaterThan(0));
    await waitFor(() => expect(atRest(month)).toBe(true));
  });

  it("springs the selected day's disc across days without blinking", async () => {
    await openSheet("2026-09-26");
    const discFor = (name: RegExp) =>
      screen.getByRole("button", { name }).querySelector("[data-day-disc]") as HTMLElement;

    const day26 = discFor(/Saturday, September 26, 2026/i);
    expect(day26).toBeTruthy();
    // initial={false}: the disc renders at its target, never mid-flight.
    expect(day26.style.opacity).toBe("1");
    expect(discFor(/Sunday, September 27, 2026/i).style.opacity).toBe("0");

    fireEvent.click(screen.getByRole("button", { name: /Sunday, September 27, 2026/i }));
    await waitFor(() => expect(discFor(/Sunday, September 27, 2026/i).style.opacity).toBe("1"));
    // The old day releases on the same node — no unmount/remount blink.
    await waitFor(() => expect(discFor(/Saturday, September 26, 2026/i).style.opacity).toBe("0"));
  });
});
