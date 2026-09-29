/**
 * Quick Appearance panel (AI-011).
 *
 * Collapsible panel owning the theme preview cards, accent swatches, text
 * size, reduce-motion override, and high-quality-photo toggle. Every control
 * applies + persists immediately — there is no Save button.
 *
 * The theme cards are custom radio cards (visual previews need layout the
 * shared Segmented control doesn't offer); text size and motion reuse
 * Segmented untouched. The selected theme card keeps the shared sliding
 * selection indicator (`data-testid="segmented-selection"`) so the Profile
 * press-state regression guard keeps passing.
 */

import { useId, useRef, useState } from "react";
import { motion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import { useTheme, type Theme } from "../theme";
import {
  ACCENT_OPTIONS,
  REDUCE_MOTION_OPTIONS,
  TEXT_SCALE_OPTIONS,
  useAppearance,
  type ReduceMotionOverride,
  type TextScaleId,
} from "../appearance";
import { Segmented } from "./Segmented";
import { motionSprings } from "./uiMotion";

const THEME_CARDS: readonly { value: Theme; hint: string }[] = [
  { value: "light", hint: "Bright surfaces" },
  { value: "dark", hint: "Dimmed surfaces" },
  // "System" IS the Auto mode — it follows the device setting.
  { value: "system", hint: "Auto · follows device" },
];

function themeLabel(value: Theme): string {
  if (value === "light") return "Light";
  if (value === "dark") return "Dark";
  return "System";
}

function ThemePreview({ value }: { value: Theme }) {
  if (value === "system") {
    return (
      <span aria-hidden="true" className="flex h-10 overflow-hidden rounded-m3-xs border border-outline-variant">
        <span className="w-1/2 bg-white" />
        <span className="w-1/2 bg-[#121212]" />
      </span>
    );
  }
  const dark = value === "dark";
  return (
    <span
      aria-hidden="true"
      className={`flex h-10 flex-col justify-center gap-1 rounded-m3-xs border border-outline-variant px-2 ${
        dark ? "bg-[#121212]" : "bg-white"
      }`}
    >
      <span className={`h-1.5 w-3/4 rounded-full ${dark ? "bg-[#e6e6e0]" : "bg-[#1a1a1a]"}`} />
      <span className={`h-1.5 w-1/2 rounded-full ${dark ? "bg-[#8f8f88]" : "bg-[#74746e]"}`} />
    </span>
  );
}

export function AppearancePanel() {
  const { theme, setTheme } = useTheme();
  const { settings, update } = useAppearance();
  const [open, setOpen] = useState(true);
  const panelId = `fb-appearance-${useId().replace(/:/g, "")}`;
  const pillId = `fb-appearance-theme-${useId().replace(/:/g, "")}`;
  const cardRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function moveCardFocus(from: number, delta: 1 | -1) {
    const next = (from + delta + THEME_CARDS.length) % THEME_CARDS.length;
    cardRefs.current[next]?.focus();
    const card = THEME_CARDS[next];
    if (card) setTheme(card.value);
  }

  return (
    <section aria-label="Quick Appearance" className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-[48px] items-center justify-between gap-3 rounded-m3-md border border-outline-variant px-4 py-2 text-left hover:bg-surface-container"
      >
        <span>
          <span className="block text-sm font-medium">Quick Appearance</span>
          <span className="block text-xs text-on-surface-variant">
            Theme, accent, text size, motion, photos
          </span>
        </span>
        <ChevronDown
          size={18}
          aria-hidden="true"
          className={`shrink-0 transition-transform ${open ? "" : "-rotate-90"}`}
        />
      </button>

      {open && (
        <div
          id={panelId}
          className="flex flex-col gap-4 rounded-m3-md border border-outline-variant bg-surface-container-low p-4"
        >
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium" id={`${panelId}-theme`}>
              Theme
            </p>
            <div
              role="radiogroup"
              aria-label="Theme"
              aria-describedby={`${panelId}-theme`}
              className="grid grid-cols-3 gap-2"
              onKeyDown={(e) => {
                const active = document.activeElement;
                const index = cardRefs.current.findIndex((el) => el === active);
                if (index < 0) return;
                if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                  e.preventDefault();
                  moveCardFocus(index, 1);
                } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                  e.preventDefault();
                  moveCardFocus(index, -1);
                }
              }}
            >
              {THEME_CARDS.map((card, i) => {
                const selected = card.value === theme;
                return (
                  <button
                    key={card.value}
                    ref={(el) => {
                      cardRefs.current[i] = el;
                    }}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => setTheme(card.value)}
                    className={`relative flex min-h-[48px] flex-col gap-1.5 rounded-m3-sm border p-2 text-left transition-colors ${
                      selected
                        ? "border-on-surface text-on-surface"
                        : "border-outline-variant text-on-surface-variant hover:bg-surface-container"
                    }`}
                  >
                    {selected && (
                      <motion.span
                        layoutId={pillId}
                        data-testid="segmented-selection"
                        aria-hidden="true"
                        transition={motionSprings.snappy}
                        className="absolute inset-0 rounded-m3-sm bg-surface shadow-sm"
                      />
                    )}
                    <span className="relative z-[1] flex flex-col gap-1.5">
                      <ThemePreview value={card.value} />
                      <span className="text-xs font-medium">{themeLabel(card.value)}</span>
                      <span aria-hidden="true" className="text-[11px] leading-tight opacity-80">{card.hint}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">
              Accent color{" "}
              <span className="font-normal text-on-surface-variant">
                · {ACCENT_OPTIONS.find((a) => a.id === settings.accent)?.label}
              </span>
            </p>
            <div role="radiogroup" aria-label="Accent color" className="flex flex-wrap gap-2">
              {ACCENT_OPTIONS.map((accent) => {
                const selected = accent.id === settings.accent;
                return (
                  <button
                    key={accent.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    title={accent.label}
                    onClick={() => update({ accent: accent.id })}
                    className={`flex min-h-[48px] min-w-[48px] flex-col items-center justify-center gap-1 rounded-m3-sm border px-2 py-1 text-[11px] font-medium transition-colors ${
                      selected
                        ? "border-on-surface text-on-surface"
                        : "border-outline-variant text-on-surface-variant hover:bg-surface-container"
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className="h-6 w-6 rounded-full border border-outline-variant"
                      style={{ backgroundColor: accent.swatch }}
                    />
                    {accent.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">Text size</p>
            <Segmented<TextScaleId>
              ariaLabel="Text size"
              value={settings.textScale}
              onChange={(textScale) => update({ textScale })}
              options={TEXT_SCALE_OPTIONS.map((t) => ({ value: t.id, label: t.label }))}
            />
            <p className="text-xs text-on-surface-variant">
              Scales app text immediately via the root font size.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">Motion</p>
            <Segmented<ReduceMotionOverride>
              ariaLabel="Reduce motion"
              value={settings.reduceMotion}
              onChange={(reduceMotion) => update({ reduceMotion })}
              options={[...REDUCE_MOTION_OPTIONS]}
            />
            <p className="text-xs text-on-surface-variant">
              System follows your device setting; Reduce and Full override it.
            </p>
          </div>

          <button
            type="button"
            role="switch"
            aria-checked={settings.highQualityPhoto}
            onClick={() => update({ highQualityPhoto: !settings.highQualityPhoto })}
            className="flex min-h-[48px] items-center justify-between gap-3 rounded-m3-sm border border-outline-variant px-3 py-2 text-left hover:bg-surface-container"
          >
            <span>
              <span className="block text-sm font-medium">High quality photo</span>
              <span className="block text-xs text-on-surface-variant">
                Larger uploads — uses more data and storage.
              </span>
            </span>
            <span
              aria-hidden="true"
              className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                settings.highQualityPhoto ? "bg-on-surface" : "bg-surface-container-high"
              }`}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-surface shadow-sm transition-all ${
                  settings.highQualityPhoto ? "left-[22px]" : "left-0.5"
                }`}
              />
            </span>
          </button>
        </div>
      )}
    </section>
  );
}
