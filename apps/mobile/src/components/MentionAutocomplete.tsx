import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { SearchedProfile } from "@findback/shared";
import { searchProfilesByPrefix } from "../services/profile";
import { UserAvatar } from "./UserAvatar";

/** A locally known mention target: discussion participant or report owner. */
export interface MentionCandidate {
  username: string;
  displayName?: string | null;
  avatarUrl?: string | null;
}

export interface MentionAutocompleteProps {
  /** Ref to the controlled comment field (input or expanding textarea). */
  inputRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  /** Current composer text (controlled by the parent). */
  value: string;
  /** Discussion participants, already ranked first. */
  participants: MentionCandidate[];
  /** Report owner, ranked second. */
  owner?: MentionCandidate | null;
  /** Parent replaces the "@frag" token and restores the caret. */
  onInsert: (next: string, caret: number) => void;
}

/** Token before the caret; opens on a bare "@" (empty fragment allowed). */
const MENTION_TOKEN_RE = /@([A-Za-z0-9_]{0,30})$/;
/** Server fan-out guard: matches the service short-circuit threshold. */
const MIN_SERVER_PREFIX = 2;
/** Debounce so fast typing fires one trailing search (~150-200ms band). */
const SERVER_DEBOUNCE_MS = 175;
/** Visible rows: a small touch-friendly listbox, never a scrolling wall. */
const MAX_VISIBLE_SUGGESTIONS = 6;
/** Blur close delay so a touch/mouse select lands before unmount. */
const BLUR_CLOSE_MS = 120;

const LISTBOX_ID = "mention-autocomplete-listbox";

function tokenBeforeCaret(value: string, caret: number): { frag: string; start: number } | null {
  const before = value.slice(0, Math.max(0, Math.min(caret, value.length)));
  const match = MENTION_TOKEN_RE.exec(before);
  if (!match) return null;
  return { frag: match[1] ?? "", start: before.length - match[0].length };
}

/**
 * Controlled @mention autocomplete bound to the composer's caret. Ranked
 * merge: (1) discussion participants, (2) report owner, (3) server
 * prefix-search — prefix-filtered client-side, deduped by username, capped.
 * The parent owns the text; this component only reports token replacement.
 */
export function MentionAutocomplete({
  inputRef,
  value,
  participants,
  owner,
  onInsert,
}: MentionAutocompleteProps) {
  const [caret, setCaret] = useState<number | null>(null);
  const [serverResults, setServerResults] = useState<SearchedProfile[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [blurClosed, setBlurClosed] = useState(false);
  const seq = useRef(0);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resolvedCaret = caret ?? value.length;
  const token = tokenBeforeCaret(value, resolvedCaret);
  const tokenKey = token ? `${token.start}:${token.frag}` : null;

  // Forget an Escape dismissal as soon as the token itself changes.
  useEffect(() => {
    setDismissedKey((prev) => (prev !== null && prev !== tokenKey ? null : prev));
  }, [tokenKey]);

  // Track the caret from the live input; the controlled value alone cannot
  // tell us where the caret sits for mid-text mentions.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const sync = () => {
      setCaret(el.selectionStart ?? el.value.length);
      setBlurClosed(false);
    };
    const scheduleBlurClose = () => {
      if (blurTimer.current) clearTimeout(blurTimer.current);
      blurTimer.current = setTimeout(() => setBlurClosed(true), BLUR_CLOSE_MS);
    };
    el.addEventListener("keyup", sync);
    el.addEventListener("click", sync);
    el.addEventListener("select", sync);
    el.addEventListener("focus", sync);
    el.addEventListener("blur", scheduleBlurClose);
    return () => {
      el.removeEventListener("keyup", sync);
      el.removeEventListener("click", sync);
      el.removeEventListener("select", sync);
      el.removeEventListener("focus", sync);
      el.removeEventListener("blur", scheduleBlurClose);
      if (blurTimer.current) clearTimeout(blurTimer.current);
    };
  }, [inputRef]);

  // Debounced server prefix search with latest-wins; stale responses are
  // discarded by sequence so a slow first query never clobbers a newer one.
  useEffect(() => {
    if (!token || token.frag.length < MIN_SERVER_PREFIX) {
      setServerResults([]);
      return;
    }
    const frag = token.frag;
    const id = ++seq.current;
    const timer = setTimeout(() => {
      void searchProfilesByPrefix(frag)
        .then((rows) => {
          if (seq.current !== id) return;
          setServerResults(rows);
        })
        .catch(() => {
          // A failed prefix search only hides server rows; local
          // participants/owner stay available, so never surface an error.
          if (seq.current === id) setServerResults([]);
        });
    }, SERVER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [token?.frag, token?.start]);

  const fragLower = (token?.frag ?? "").toLowerCase();
  const suggestions: MentionCandidate[] = [];
  const seen = new Set<string>();
  const take = (c: MentionCandidate) => {
    const key = c.username.toLowerCase();
    if (!c.username || seen.has(key)) return;
    if (!c.username.toLowerCase().startsWith(fragLower)) return;
    seen.add(key);
    if (suggestions.length < MAX_VISIBLE_SUGGESTIONS) suggestions.push(c);
  };
  if (token) {
    for (const p of participants) take(p);
    if (owner) take(owner);
    for (const s of serverResults) {
      take({ username: s.username, displayName: s.displayName, avatarUrl: s.avatarUrl });
    }
  }

  useEffect(() => {
    setActiveIndex(0);
  }, [tokenKey, suggestions.length]);

  const open =
    token !== null && !blurClosed && dismissedKey !== tokenKey && suggestions.length > 0;

  // Combobox wiring on the parent-owned input (cleaned up on unmount).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.setAttribute("role", "combobox");
    el.setAttribute("aria-autocomplete", "list");
    el.setAttribute("aria-expanded", open ? "true" : "false");
    el.setAttribute("aria-controls", LISTBOX_ID);
    const active = suggestions[activeIndex];
    if (open && active) {
      el.setAttribute("aria-activedescendant", `mention-option-${active.username}`);
    } else {
      el.removeAttribute("aria-activedescendant");
    }
    return () => {
      el.removeAttribute("role");
      el.removeAttribute("aria-autocomplete");
      el.removeAttribute("aria-expanded");
      el.removeAttribute("aria-controls");
      el.removeAttribute("aria-activedescendant");
    };
  });

  function choose(index: number) {
    const picked = suggestions[index];
    if (!token || !picked) return;
    const next = `${value.slice(0, token.start)}@${picked.username} ${value.slice(resolvedCaret)}`;
    onInsert(next, token.start + picked.username.length + 2);
  }

  // Keyboard handling lives here (listener on the input) so the parent form
  // only renders this component — no handler edits to the composer itself.
  // Enter is prevented while open so selecting never submits the comment.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onKeyDown = (e: Event) => {
      const ke = e as KeyboardEvent;
      if (!token || dismissedKey === tokenKey || blurClosed || suggestions.length === 0) return;
      if (ke.key === "ArrowDown") {
        ke.preventDefault();
        setActiveIndex((i) => (i + 1) % suggestions.length);
      } else if (ke.key === "ArrowUp") {
        ke.preventDefault();
        setActiveIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
      } else if (ke.key === "Enter" || ke.key === "Tab") {
        ke.preventDefault();
        choose(activeIndex);
      } else if (ke.key === "Escape") {
        ke.preventDefault();
        setDismissedKey(tokenKey);
        el.focus();
      }
    };
    el.addEventListener("keydown", onKeyDown);
    return () => el.removeEventListener("keydown", onKeyDown);
  });

  if (!open || !token) return null;

  return (
    <div
      id={LISTBOX_ID}
      role="listbox"
      aria-label="Mention suggestions"
      className="absolute inset-x-0 top-full z-50 mt-1 overflow-hidden rounded-m3-sm border border-outline-variant bg-surface-container shadow-lg"
    >
      <ul className="max-h-56 overflow-y-auto py-1">
        {suggestions.map((s, i) => (
          <li key={s.username.toLowerCase()}>
            <div
              id={`mention-option-${s.username}`}
              role="option"
              aria-selected={i === activeIndex}
              onMouseDown={(e) => {
                // PreventDefault keeps the caret in the input so a
                // touch/mouse select never blurs before it lands.
                e.preventDefault();
                choose(i);
              }}
              onMouseEnter={() => setActiveIndex(i)}
              className={`flex min-h-[48px] cursor-pointer items-center gap-2 px-3 py-2 ${
                i === activeIndex ? "bg-surface-container-high" : ""
              }`}
            >
              <UserAvatar username={s.username} avatarUrl={s.avatarUrl ?? null} size={28} />
              <span className="min-w-0 flex-1 truncate text-sm">
                <span className="font-medium text-on-surface">
                  {s.displayName?.trim() ? s.displayName : s.username}
                </span>{" "}
                <span className="text-on-surface-variant">@{s.username}</span>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
