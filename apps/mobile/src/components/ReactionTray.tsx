import { useEffect, useRef } from "react";
import { Heart, Lightbulb, HeartHandshake, Sparkles } from "lucide-react";
import type {
  CanonicalReactionKind,
  ReactionCounts,
  ReactionKind,
} from "@findback/shared";
import { CANONICAL_REACTION_KINDS } from "@findback/shared";
import { REACTION_KINDS, normalizeReactionKind } from "../services/reactions";
import { REACTION_KIND_FUNCTIONAL } from "../design/functionalColors";

/**
 * W3.3 multi-kind reaction tray: the shared picker for posts and comments.
 *
 * Controlled (`open`): the caller owns tap suppression (see `useLongPress`)
 * and server writes — this component only collects the user's choice through
 * pointer, keyboard (arrows + Enter, no long-press needed), and screen-reader
 * (menu/menuitemradio semantics) paths. Escape closes and returns focus to
 * `triggerId`. Haptic (`navigator.vibrate`) fires once on open, guarded so
 * unsupported platforms stay a silent no-op; no native code is involved.
 */

const KIND_ICONS: Record<CanonicalReactionKind, typeof Heart> = {
  LOVE: Heart,
  HELPFUL: Lightbulb,
  SUPPORT: HeartHandshake,
  WOW: Sparkles,
};

/**
 * W5 functional kind colors (Love rose, Helpful blue, Support teal-green,
 * Wow bronze). Icon + count only, on the neutral tray surface — the label
 * keeps the surrounding tone and the user accent never applies here.
 */
const KIND_COLOR_VAR: Record<CanonicalReactionKind, string> = {
  LOVE: "var(--fb-reaction-love)",
  HELPFUL: "var(--fb-reaction-helpful)",
  SUPPORT: "var(--fb-reaction-support)",
  WOW: "var(--fb-reaction-wow)",
};

export function reactionKindLabel(kind: CanonicalReactionKind): string {
  return REACTION_KINDS.find((m) => m.kind === kind)?.label ?? kind;
}

/** Highest-count kind; ties resolve in canonical tray order; empty → null. */
export function topReactionKind(counts: ReactionCounts): CanonicalReactionKind | null {
  let best: CanonicalReactionKind | null = null;
  let bestCount = 0;
  for (const kind of CANONICAL_REACTION_KINDS) {
    const n = counts[kind] ?? 0;
    if (n > bestCount) {
      best = kind;
      bestCount = n;
    }
  }
  return best;
}

export interface ReactionTrayProps {
  open: boolean;
  /** Caller's current reaction (raw wire kind accepted; LIKE reads as LOVE). */
  myReaction: ReactionKind | null;
  counts: ReactionCounts;
  total: number;
  pending?: boolean;
  onSelect: (kind: CanonicalReactionKind) => void;
  onClose: () => void;
  /** Element id to restore focus to on Escape (the tray trigger). */
  triggerId: string;
}

export function ReactionTray({
  open,
  myReaction,
  counts,
  total,
  pending = false,
  onSelect,
  onClose,
  triggerId,
}: ReactionTrayProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const activeKind =
    myReaction === null ? null : (normalizeReactionKind(myReaction) as CanonicalReactionKind);

  // Focus the active kind (else the first) so arrows/Enter work immediately.
  useEffect(() => {
    if (!open) return;
    const index = activeKind ? CANONICAL_REACTION_KINDS.indexOf(activeKind) : 0;
    itemRefs.current[index]?.focus();
  }, [open, activeKind]);

  // Haptic on open only: guarded, try/catch, no-op where unsupported.
  useEffect(() => {
    if (!open) return;
    try {
      navigator.vibrate?.(10);
    } catch {
      // Vibration is a nicety; never break the tray.
    }
  }, [open ]);

  if (!open) return null;

  function focusAt(index: number) {
    const clamped = (index + CANONICAL_REACTION_KINDS.length) % CANONICAL_REACTION_KINDS.length;
    itemRefs.current[clamped]?.focus();
  }

  function focusedIndex(): number {
    const active = document.activeElement;
    const found = itemRefs.current.findIndex((el) => el === active);
    return found >= 0 ? found : 0;
  }

  function onMenuKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        e.preventDefault();
        focusAt(focusedIndex() + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        e.preventDefault();
        focusAt(focusedIndex() - 1);
        break;
      case "Home":
        e.preventDefault();
        focusAt(0);
        break;
      case "End":
        e.preventDefault();
        focusAt(CANONICAL_REACTION_KINDS.length - 1);
        break;
      case "Enter":
      case " ": {
        const el = document.activeElement as HTMLButtonElement | null;
        const kind = el?.dataset.kind as CanonicalReactionKind | undefined;
        if (kind && CANONICAL_REACTION_KINDS.includes(kind)) {
          e.preventDefault();
          onSelect(kind);
        }
        break;
      }
      case "Escape":
        e.preventDefault();
        closeRef.current();
        // Focus returns to the trigger so keyboard/screen-reader users land
        // back where they opened the tray.
        document.getElementById(triggerId)?.focus();
        break;
    }
  }

  return (
    <div
      ref={menuRef}
      role="menu"
      data-testid="reaction-tray"
      aria-label={`Choose a reaction, ${total} ${total === 1 ? "reaction" : "reactions"} so far`}
      onKeyDown={onMenuKeyDown}
      className="flex items-stretch gap-1 rounded-m3-lg border border-outline-variant bg-surface-container p-1 shadow-md"
    >
      {CANONICAL_REACTION_KINDS.map((kind, index) => {
        const Icon = KIND_ICONS[kind];
        const count = counts[kind] ?? 0;
        const checked = activeKind === kind;
        return (
          <button
            key={kind}
            ref={(el) => {
              itemRefs.current[index] = el;
            }}
            type="button"
            role="menuitemradio"
            aria-checked={checked}
            data-testid={`reaction-option-${kind}`}
            data-kind={kind}
            data-functional-color={REACTION_KIND_FUNCTIONAL[kind]}
            disabled={pending}
            onClick={() => onSelect(kind)}
            className={`flex min-h-[44px] min-w-[44px] flex-1 flex-col items-center justify-center gap-0.5 rounded-m3-md px-2 py-1 text-xs font-medium ${
              checked ? "bg-surface-container-high text-on-surface" : "text-on-surface-variant"
            }`}
          >
            <Icon size={20} aria-hidden fill={checked ? "currentColor" : "none"} style={{ color: KIND_COLOR_VAR[kind] }} />
            <span>{reactionKindLabel(kind)}</span>
            <span aria-hidden className="tabular-nums" style={{ color: KIND_COLOR_VAR[kind] }}>{count}</span>
          </button>
        );
      })}
    </div>
  );
}
