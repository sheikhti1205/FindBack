import { useId, useRef } from "react";
import { motion } from "framer-motion";
import type { PostStatus, PostType } from "@findback/shared";
import { motionSprings } from "./uiMotion";

interface SegmentedProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  ariaLabel?: string;
  disabled?: boolean;
  /** Let sentence-length options wrap into rows as text grows. */
  wrapLongLabels?: boolean;
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  disabled = false,
  wrapLongLabels = false,
}: SegmentedProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  // Scoped layoutId so the selection background slides within this group
  // only (multiple Segmented controls share the page).
  const selectionId = `fb-segmented-${useId().replace(/:/g, "")}`;

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
      className={`${wrapLongLabels ? "flex flex-wrap" : "grid auto-cols-fr grid-flow-col"} rounded-m3-sm bg-surface-container p-1`}
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
            className={`relative min-h-[48px] rounded-m3-xs px-3 text-sm font-medium transition-colors ${wrapLongLabels ? "min-w-0 flex-1 basis-[max-content] [overflow-wrap:anywhere]" : ""} ${
              disabled
                ? "opacity-50 cursor-not-allowed"
                : selected
                ? "text-on-surface"
                : "text-on-surface-variant hover:bg-surface-container-high"
            }`}
          >
            {selected && (
              <motion.span
                layoutId={selectionId}
                data-testid="segmented-selection"
                aria-hidden="true"
                transition={motionSprings.snappy}
                className="absolute inset-0 rounded-m3-xs bg-surface shadow-sm"
              />
            )}
            <span className={`relative z-[1] ${wrapLongLabels ? "block" : ""}`}>{o.label}</span>
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
