import { useId, useRef, useState, type KeyboardEvent } from "react";
import {
  Calendar,
  CalendarGrid,
  CalendarGridHeader,
  CalendarHeaderCell,
  CalendarCell,
  CalendarGridBody,
  CalendarHeading,
  Button as AriaButton,
} from "react-aria-components";
import { parseDate, CalendarDate, CalendarDateTime, ZonedDateTime, today, getLocalTimeZone } from "@internationalized/date";
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight, X, Check } from "lucide-react";
import { BottomSheet } from "./BottomSheet";
import { Button } from "./Button";

interface ReportDatePickerProps {
  value: string;
  onChange: (value: string) => void;
  error?: string;
  id?: string;
  expected?: "LOST" | "FOUND";
  "aria-describedby"?: string;
}

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});

function formatDisplay(date: CalendarDate): string {
  return DATE_FORMAT.format(date.toDate(getLocalTimeZone()));
}

function parseISO(value: string): CalendarDate | null {
  try {
    return parseDate(value);
  } catch {
    return null;
  }
}

function isFutureDate(date: CalendarDate | CalendarDateTime | ZonedDateTime): boolean {
  // The server rejects event_date > (now() at time zone 'utc')::date, so the
  // client must cap on the SAME UTC day or it can offer a doomed date.
  const now = today("UTC");
  const calDate = "day" in date && !("hour" in date) ? date : new CalendarDate(date.year, date.month, date.day);
  return calDate.compare(now) > 0;
}

export function ReportDatePicker({
  value,
  onChange,
  error,
  id: providedId,
  expected,
  "aria-describedby": ariaDescribedBy,
}: ReportDatePickerProps) {
  const id = useId();
  const triggerId = providedId || `${id}-trigger`;
  const calendarId = `${id}-calendar`;
  const errorId = `${id}-error`;
  const descriptionId = `${id}-description`;

  const [isOpen, setIsOpen] = useState(false);
  const [displayedValue, setDisplayedValue] = useState<CalendarDate | null>(() =>
    value ? parseISO(value) : null
  );

  const triggerRef = useRef<HTMLButtonElement>(null);

  const maxDate = today("UTC");

  const openSheet = () => {
    setDisplayedValue(value ? parseISO(value) : null);
    setIsOpen(true);
  };

  const closeSheet = (commit = false) => {
    if (commit && displayedValue && !isFutureDate(displayedValue)) {
      onChange(displayedValue.toString());
    }
    setIsOpen(false);
  };

  const handleConfirm = () => {
    closeSheet(true);
  };

  const handleCancel = () => {
    closeSheet(false);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape") {
      handleCancel();
    } else if ((event.key === "Enter" || event.key === " ") && !isOpen) {
      // A real <button> would fire click on Enter/Space; preventDefault keeps
      // control here, so opening the sheet must be explicit.
      event.preventDefault();
      openSheet();
    }
  };

  const displayValue = value ? parseISO(value) : null;
  const displayText = displayValue ? formatDisplay(displayValue) : "Select date";
  const hasError = Boolean(error);

  const describedBy = [
    ariaDescribedBy,
    hasError ? errorId : undefined,
    descriptionId,
  ].filter(Boolean).join(" ") || undefined;

  return (
    <div className="w-full">
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        role="button"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-invalid={hasError || undefined}
        aria-describedby={describedBy}
        aria-label={`Date of event${expected ? ` (${expected.toLowerCase()})` : ""}. ${displayText}`}
        className={`w-full min-h-[48px] flex items-center justify-between gap-3 rounded-m3-md border px-3.5 py-3 text-base text-on-surface bg-surface transition-colors ${
          hasError ? "border-error" : "border-outline-variant"
        } hover:border-on-surface focus:outline-none focus:ring-2 focus:ring-on-surface`}
        onClick={openSheet}
        onKeyDown={handleKeyDown}
      >
        <span className="flex items-center gap-2 min-w-0 flex-1 text-start">
          <CalendarIcon size={20} aria-hidden className="text-on-surface-variant shrink-0" />
          <span className="truncate">{displayText}</span>
        </span>
        <ChevronRight size={20} aria-hidden className="text-on-surface-variant shrink-0" />
      </button>

      {hasError && (
        <span id={errorId} className="mt-1 block text-xs text-error" role="alert">
          {error}
        </span>
      )}

      <BottomSheet
        open={isOpen}
        onClose={handleCancel}
        title={`When was it ${expected?.toLowerCase() || "lost/found"}?`}
        description="Select the date from the calendar below."
        height="large"
        dismissible={true}
        closeLabel="Close"
      >
        <div id={descriptionId} className="sr-only">
          Calendar for selecting the date. Use arrow keys to navigate days, Page Up/Down to change months, Enter to select, Escape to cancel.
        </div>

        <Calendar
          id={calendarId}
          value={displayedValue}
          onChange={setDisplayedValue}
          maxValue={maxDate}
          isDateUnavailable={isFutureDate}
          selectionMode="single"
          autoFocus
          className="w-full"
        >
          <header className="flex items-center justify-between gap-2 mb-2">
            <AriaButton
              slot="previous"
              className="flex min-h-[48px] min-w-[48px] items-center justify-center rounded-m3-sm text-on-surface-variant hover:bg-surface-container transition-colors"
              aria-label="Previous month"
            >
              <ChevronLeft size={24} aria-hidden />
            </AriaButton>
            <CalendarHeading className="flex-1 text-center text-base font-semibold text-on-surface" />
            <AriaButton
              slot="next"
              className="flex min-h-[48px] min-w-[48px] items-center justify-center rounded-m3-sm text-on-surface-variant hover:bg-surface-container transition-colors"
              aria-label="Next month"
            >
              <ChevronRight size={24} aria-hidden />
            </AriaButton>
          </header>

          <CalendarGrid className="w-full">
            <CalendarGridHeader className="mb-1">
              {(day) => (
                <CalendarHeaderCell className="text-xs font-medium text-on-surface-variant py-1">
                  {day}
                </CalendarHeaderCell>
              )}
            </CalendarGridHeader>

            <CalendarGridBody>
              {(date) => (
                <CalendarCell
                  key={date.toString()}
                  date={date}
                  className={({ isSelected, isToday, isUnavailable, isOutsideVisibleRange, isDisabled }: {
                    isSelected: boolean;
                    isToday: boolean;
                    isUnavailable: boolean;
                    isOutsideVisibleRange: boolean;
                    isDisabled: boolean;
                  }) =>
                    [
                      "flex items-center justify-center h-10 w-full rounded-full transition-colors",
                      isOutsideVisibleRange && "text-on-surface-variant/30",
                      isUnavailable && "text-on-surface-variant/30 line-through",
                      isDisabled && "opacity-50 cursor-not-allowed",
                      isSelected && "bg-on-surface text-surface font-medium",
                      isToday && !isSelected && "ring-2 ring-on-surface",
                      isToday && isSelected && "ring-2 ring-on-surface",
                    ]
                      .filter(Boolean)
                      .join(" ")
                  }
                >
                  {date.day}
                </CalendarCell>
              )}
            </CalendarGridBody>
          </CalendarGrid>

          <div className="flex items-center justify-between mt-4 pt-4 border-t border-outline-variant">
            <Button
              variant="text"
              size="md"
              onClick={() => {
                // Server-aligned "today" (UTC) so the shortcut can never pick a
                // date the validator rejects at the local/UTC day boundary.
                const todayDate = today("UTC");
                setDisplayedValue(new CalendarDate(todayDate.year, todayDate.month, todayDate.day));
              }}
              className="text-on-surface-variant hover:text-on-surface"
            >
              Today
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" size="md" onClick={handleCancel}>
                <X size={16} aria-hidden className="mr-1" />
                Cancel
              </Button>
              <Button variant="primary" size="md" onClick={handleConfirm} disabled={!displayedValue || isFutureDate(displayedValue)}>
                <Check size={16} aria-hidden className="mr-1" />
                Confirm
              </Button>
            </div>
          </div>
        </Calendar>
      </BottomSheet>
    </div>
  );
}
