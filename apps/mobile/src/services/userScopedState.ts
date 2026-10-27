import { clearFeedCaches } from "../hooks/feedCache";
import { clearNearbySession } from "./nearby";
import { clearPhotoStore } from "./photoStore";
import { resetLocalAiForAccount } from "./ai/applicationAi";
import { clearDraft } from "./reportDraft";
import { clearMessagingRuntime } from "./messaging/runtime";

/**
 * Drops all user-scoped local data: the in-memory report draft, stashed
 * photo Files, feed caches, and the private Nearby search center. Must run
 * on every sign-out path (explicit logout, Supabase SIGNED_OUT, mid-session
 * refresh failure), otherwise the next account inherits the previous user's
 * draft, photos, and search area.
 *
 * Phase A (Step 8): on-device AI residency is also released (in-flight
 * inference aborted, engines unloaded best-effort). Model downloads survive:
 * logout never wipes verified model files.
 */
export function clearUserScopedLocalState(): void {
  clearMessagingRuntime();
  clearDraft();
  clearPhotoStore();
  clearFeedCaches();
  clearNearbySession();
  void resetLocalAiForAccount();
}
