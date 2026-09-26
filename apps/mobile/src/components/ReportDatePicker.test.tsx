// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReportDatePicker } from "./ReportDatePicker";

afterEach(() => {
  cleanup();
});

describe("ReportDatePicker", () => {
  const onChange = vi.fn();

  afterEach(() => {
    onChange.mockClear();
  });

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

    // Future dates in current month (Sep 27-30) should be disabled
    const futureCell = screen.getByRole("button", { name: /Sunday, September 27, 2026/i });
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

    // The calendar should show today (Sep 26 UTC) as selected
    const todayCell = screen.getByRole("button", { name: /Saturday, September 26, 2026 selected/ });
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
    // 2026-02-29 doesn't exist, so it can't be selected in the calendar
    // Navigate to February 2026 using previous month button
    render(<ReportDatePicker value="" onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: /date of event/i });
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
    });

    // Navigate back to February 2026 (7 months back from September)
    const prevButton = screen.getByRole("button", { name: /previous month/i });
    for (let i = 0; i < 7; i++) {
      fireEvent.click(prevButton);
      await waitFor(() => {
        // Wait for month to change
      });
    }

    // The calendar should show 28 days in February 2026
    const feb28Cell = screen.getByRole("button", { name: /February 28, 2026/i });
    expect(feb28Cell).toBeTruthy();

    // There should be no 29th
    expect(screen.queryByRole("button", { name: /February 29, 2026/i })).toBeFalsy();
  });

  it("rejects 2026-04-31 (invalid day overflow)", async () => {
    // April has 30 days, so 31st should not exist
    // Navigate to April 2026 (5 months back from September)
    render(<ReportDatePicker value="" onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: /date of event/i });
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
    });

    const prevButton = screen.getByRole("button", { name: /previous month/i });
    for (let i = 0; i < 5; i++) {
      fireEvent.click(prevButton);
      await waitFor(() => {});
    }

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
    const futureCell = screen.getByRole("button", { name: /Sunday, September 27, 2026/i });
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
    } finally {
      vi.useRealTimers();
    }
  });
});
