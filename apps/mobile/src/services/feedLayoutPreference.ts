/**
 * Feed layout preference (CF-010, packet `09` §6 and §23).
 *
 * The reader picks how the post feed is laid out: `auto` decides from the
 * viewport, the other three are explicit. This module is the single owner of
 * *where that choice lives*; `components/responsive.ts` owns what a choice
 * means on a viewport (`resolveFeedLayout`) and how wide a masonry column is.
 *
 * Persistence follows the appearance policy (`appearance.ts`): device-local
 * storage, applied the moment it is picked, no Save step, and other tabs/mounts
 * re-sync through one custom event plus the native `storage` event. The
 * preference is deliberately *not* account state — it describes the screen the
 * reader is holding, so it survives sign-out the way text size does.
 */
import { useCallback, useEffect, useState } from "react";
import type { FeedLayout } from "../components/responsive";

/** Storage key; versioned like the other owner-local preference keys. */
export const FEED_LAYOUT_STORAGE_KEY = "findback.feedLayout.v1";

/** Window event fired on every save so other tabs/mounts re-apply. */
export const FEED_LAYOUT_EVENT = "findback:feedLayout";

/** Auto is the default: the viewport decides until the reader says otherwise. */
export const DEFAULT_FEED_LAYOUT: FeedLayout = "auto";

const FEED_LAYOUTS: readonly FeedLayout[] = ["auto", "feed", "compact", "masonry"];

/**
 * Narrow arbitrary persisted data to a layout.
 *
 * Unknown keys (an older build, a hand-edited value, a future layout this build
 * does not know) read as `auto` rather than as "the last one that happened to
 * parse" — a layout the reader never chose is worse than the default.
 */
export function migrateFeedLayout(value: unknown): FeedLayout {
  return typeof value === "string" && (FEED_LAYOUTS as readonly string[]).includes(value)
    ? (value as FeedLayout)
    : DEFAULT_FEED_LAYOUT;
}

/** The stored preference, or `auto` when unset/unreadable. Never throws. */
export function loadFeedLayout(): FeedLayout {
  try {
    const raw = localStorage.getItem(FEED_LAYOUT_STORAGE_KEY);
    if (raw === null) return DEFAULT_FEED_LAYOUT;
    return migrateFeedLayout(JSON.parse(raw));
  } catch {
    return DEFAULT_FEED_LAYOUT;
  }
}

/** Persist and announce a layout. Storage failure ("don't persist") is fine. */
export function saveFeedLayout(layout: FeedLayout): void {
  try {
    localStorage.setItem(FEED_LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  } catch {
    /* private mode: the session still honors the in-memory value */
  }
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new CustomEvent(FEED_LAYOUT_EVENT, { detail: layout }));
  }
}

export interface FeedLayoutPreferenceApi {
  layout: FeedLayout;
  setLayout: (layout: FeedLayout) => void;
}

/**
 * Reactive feed layout preference.
 *
 * Reads storage during the first render (so the first paint already has the
 * right layout — a correction after mount would be a visible reflow), then
 * follows saves from this hook, other hooks, and other tabs.
 */
export function useFeedLayoutPreference(): FeedLayoutPreferenceApi {
  const [layout, setLayoutState] = useState<FeedLayout>(loadFeedLayout);

  useEffect(() => {
    const sync = (event: Event) => {
      // A foreign-key storage event must not be mistaken for a layout change.
      if (
        event instanceof StorageEvent &&
        event.key !== FEED_LAYOUT_STORAGE_KEY &&
        event.key !== null
      ) {
        return;
      }
      const next =
        event instanceof CustomEvent && event.detail !== undefined
          ? migrateFeedLayout(event.detail)
          : loadFeedLayout();
      setLayoutState(next);
    };
    window.addEventListener(FEED_LAYOUT_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(FEED_LAYOUT_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const setLayout = useCallback((next: FeedLayout) => {
    const resolved = migrateFeedLayout(next);
    setLayoutState(resolved);
    saveFeedLayout(resolved);
  }, []);

  return { layout, setLayout };
}
