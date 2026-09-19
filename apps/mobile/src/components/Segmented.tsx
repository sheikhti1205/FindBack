import { useRef } from "react";
import type { PostStatus, PostType } from "@findback/shared";

interface SegmentedProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  ariaLabel?: string;
  disabled?: boolean;
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  disabled = false,
}: SegmentedProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  function moveFocus(from: number, delta: 1 | -1) {
    const next = (from + delta + options.length) % options.length;
    refs.current[next]?.focus();
    onChange(options[next]!.value);
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled}
      className="grid auto-cols-fr grid-flow-col rounded-m3-sm bg-surface-container p-1"
      onKeyDown={(e) => {
        if (disabled) return;
        const active = document.activeElement;
        const index = refs.current.findIndex((el) => el === active);
        if (index < 0) return;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          moveFocus(index, 1);
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          moveFocus(index, -1);
        }
      }}
    >
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-disabled={disabled}
            // Roving focus: one tab stop for the group; arrows move within it.
            tabIndex={disabled ? -1 : selected ? 0 : -1}
            onClick={() => !disabled && onChange(o.value)}
            className={`min-h-[48px] rounded-m3-xs px-3 text-sm font-medium transition-colors ${
              disabled
                ? "opacity-50 cursor-not-allowed"
                : selected
                ? "bg-surface text-on-surface shadow-sm"
                : "text-on-surface-variant hover:bg-surface-container-high"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export const POST_TYPE_OPTIONS: { value: PostType; label: string }[] = [
  { value: "LOST", label: "Lost" },
  { value: "FOUND", label: "Found" },
];

export const STATUS_OPTIONS: { value: PostStatus; label: string }[] = [
  { value: "OPEN", label: "Open" },
  { value: "MATCHED", label: "Matched" },
  { value: "RECOVERED", label: "Recovered" },
  { value: "CLOSED", label: "Closed" },
];

export function statusLabel(status: PostStatus): string {
  return STATUS_OPTIONS.find((s) => s.value === status)?.label ?? status;
}
