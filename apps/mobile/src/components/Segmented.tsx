import type { PostStatus, PostType } from "@findback/shared";

interface SegmentedProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  ariaLabel?: string;
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: SegmentedProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="grid auto-cols-fr grid-flow-col rounded-m3-sm bg-surface-container p-1"
    >
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(o.value)}
            className={`min-h-[48px] rounded-m3-xs px-3 text-sm font-medium transition-colors ${
              selected
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
