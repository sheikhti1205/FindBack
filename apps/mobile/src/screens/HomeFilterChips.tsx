import { useId, useRef } from "react";
import { motion } from "framer-motion";
import type { PostType } from "@findback/shared";
import { CircleAlert, CircleCheck, Clock3, Inbox, MapPin } from "lucide-react";
import { motionSprings } from "../components/uiMotion";
import type { NearbyRadiusKm } from "../services/nearby";

export type HomeTypeFilter = PostType | "ALL";

const OPTIONS: { value: HomeTypeFilter; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "LOST", label: "Lost" },
  { value: "FOUND", label: "Found" },
];

/**
 * Home-only quick filter chips (reference-inspired redesign). Same state
 * contract as the previous Segmented control — radiogroup with roving focus,
 * driving the URL-backed type filter — but glanceable pill visuals:
 * horizontally scrollable, never wrapping, selected chip strongly filled.
 * Shares one scroll row with the independent discovery-scope toggles.
 */
export function HomeFilterChips({
  value,
  onChange,
  disabled = false,
}: {
  value: HomeTypeFilter;
  onChange: (value: HomeTypeFilter) => void;
  disabled?: boolean;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectionId = `fb-home-chips-${useId().replace(/:/g, "")}`;

  function moveFocus(from: number, delta: 1 | -1) {
    const next = (from + delta + OPTIONS.length) % OPTIONS.length;
    refs.current[next]?.focus();
    onChange(OPTIONS[next]!.value);
  }

  return (
    <div
      role="radiogroup"
      aria-label="Post type"
      aria-disabled={disabled}
      className="flex shrink-0 gap-2"
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
      {OPTIONS.map((o, i) => {
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
            tabIndex={disabled ? -1 : selected ? 0 : -1}
            onClick={() => !disabled && onChange(o.value)}
            className={`relative flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-full border px-4 text-sm font-medium transition-colors ${
              disabled
                ? "cursor-not-allowed opacity-50"
                : selected
                  ? "border-transparent text-surface"
                  : "border-outline-variant bg-surface text-on-surface-variant hover:bg-surface-container"
            }`}
          >
            {selected && (
              <motion.span
                layoutId={selectionId}
                data-testid="home-chips-selection"
                aria-hidden="true"
                transition={motionSprings.snappy}
                className="absolute inset-0 rounded-full bg-on-surface"
              />
            )}
            <span className="relative z-[1] flex items-center gap-1.5">
              {o.value === "LOST" ? (
                <CircleAlert size={16} aria-hidden />
              ) : o.value === "FOUND" ? (
                <CircleCheck size={16} aria-hidden />
              ) : null}
              {o.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Combinable scope row (UXN-1): Nearby | Open | Recent.
 *
 * Unlike the exclusive All/Lost/Found radiogroup above, these are independent
 * toggle switches that combine freely (Lost+Nearby, Found+Recent,
 * All+Open+Recent, ...). Nearby never replaces the type dimension.
 *
 * Toggle buttons (aria-pressed), never radios, so the type radiogroup keeps
 * its single-selection semantics for assistive tech.
 */
export function HomeScopeChips({
  nearbyActive,
  nearbyRadiusKm,
  locating = false,
  openActive = false,
  recentActive = false,
  disabled = false,
  onNearbyTap,
  onOpenTap,
  onRecentTap,
}: {
  nearbyActive: boolean;
  nearbyRadiusKm: NearbyRadiusKm;
  locating?: boolean;
  openActive?: boolean;
  recentActive?: boolean;
  disabled?: boolean;
  onNearbyTap: () => void;
  onOpenTap: () => void;
  onRecentTap: () => void;
}) {
  const chips = [
    {
      key: "nearby",
      label: nearbyActive ? `Nearby · ${nearbyRadiusKm} km` : locating ? "Locating…" : "Nearby",
      pressed: nearbyActive,
      onTap: onNearbyTap,
      icon: <MapPin size={16} aria-hidden />,
    },
    {
      key: "open",
      label: "Open",
      pressed: openActive,
      onTap: onOpenTap,
      icon: <Inbox size={16} aria-hidden />,
    },
    {
      key: "recent",
      label: "Recent",
      pressed: recentActive,
      onTap: onRecentTap,
      icon: <Clock3 size={16} aria-hidden />,
    },
  ] as const;
  return (
    <div role="group" aria-label="Discovery scope" className="flex shrink-0 gap-2">
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          aria-pressed={chip.pressed}
          aria-disabled={disabled}
          disabled={disabled}
          onClick={chip.onTap}
          className={`flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-full border px-4 text-sm font-medium transition-colors ${
            disabled
              ? "cursor-not-allowed opacity-50"
              : chip.pressed
                ? "border-transparent bg-on-surface text-surface"
                : "border-outline-variant bg-surface text-on-surface-variant hover:bg-surface-container"
          }`}
        >
          {chip.icon}
          {chip.label}
        </button>
      ))}
    </div>
  );
}
