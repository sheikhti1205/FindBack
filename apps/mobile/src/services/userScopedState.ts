import { clearFeedCaches } from "../hooks/feedCache";
import { clearPhotoStore } from "./photoStore";
import { clearDraft } from "./reportDraft";

/**
 * Drops all user-scoped local data: the in-memory report draft, stashed
 * photo Files, and feed caches. Must run on every sign-out path
 * (explicit logout, Supabase SIGNED_OUT, mid-session refresh failure),
 * otherwise the next account inherits the previous user's draft and photos.
 */
export function clearUserScopedLocalState(): void {
  clearDraft();
  clearPhotoStore();
  clearFeedCaches();
}
