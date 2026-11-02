import { useEffect, useState } from "react";
import { getSupabase } from "../supabaseClient";

/**
 * Private report media addresses.
 *
 * P11 made report photos non-public: the object lives in the private
 * `findback-report-media` bucket and Storage only signs it while the caller can
 * currently read the owning report. New rows therefore carry a Storage *key*
 * (for example `<uid>/<uuid>.jpg`) where older rows carried a permanent public
 * URL, and the UI resolves a short-lived signed URL here.
 *
 * One cache, one in-flight promise per key: a feed page resolves every photo
 * once, and every consumer (card, carousel, viewer) reuses the same URL until
 * shortly before it expires.
 */

export const PRIVATE_MEDIA_BUCKET = "findback-report-media";

/** Supabase Storage maximum is one week; an hour is plenty for a page view. */
const SIGNED_URL_TTL_SECONDS = 60 * 60;
/** Refresh before the URL actually expires so a visible photo never flickers. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface CachedMediaUrl {
  url: string;
  expiresAt: number;
}

const cache = new Map<string, CachedMediaUrl>();
const inFlight = new Map<string, Promise<string | null>>();

/** Stable new addresses and legacy public addresses in the now-private bucket. */
export function privateCommentMediaKey(value?: string | null): string | undefined {
  const match = /^https:\/\/[a-zA-Z0-9-]+\.supabase\.co\/storage\/v1\/object\/(?:public|authenticated)\/findback-comment-media\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)$/.exec(value ?? "");
  return match?.[1] && !match[1].includes("..") ? match[1] : undefined;
}

/** A report-media key is exactly what the staging RPC derives: `<uid>/<file>`. */
const PRIVATE_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[^/]+$/i;

/**
 * True when the value is a private Storage key rather than a ready-to-use URL.
 *
 * Legacy rows keep absolute `https://` URLs, provider GIFs are `https://`, local
 * previews are `blob:`, fixtures use their own scheme, and an older row may
 * still hold a root-relative path — all of those are returned unchanged. Only
 * the exact `<uuid>/<file>` shape the server derives is signed, so an app-local
 * path can never be mistaken for a bucket object.
 */
export function isPrivateMediaKey(value: string | null | undefined): value is string {
  return typeof value === "string" && (PRIVATE_KEY_RE.test(value) || !!privateCommentMediaKey(value));
}

/** Synchronous cache read: a URL only when one is already fresh. */
export function peekMediaUrl(value?: string | null): string | undefined {
  if (!value) return undefined;
  // Never share comment authority through the process-wide report cache.
  if (privateCommentMediaKey(value)) return undefined;
  if (!isPrivateMediaKey(value)) return value;
  const hit = cache.get(value);
  return hit && hit.expiresAt > Date.now() ? hit.url : undefined;
}

async function signOne(key: string): Promise<string | null> {
  const shared = inFlight.get(key);
  if (shared) return shared;
  const task = (async () => {
    try {
      const { data, error } = await getSupabase()
        .storage.from(PRIVATE_MEDIA_BUCKET)
        .createSignedUrl(key, SIGNED_URL_TTL_SECONDS);
      if (error || !data?.signedUrl) return null;
      cache.set(key, {
        url: data.signedUrl,
        expiresAt: Date.now() + SIGNED_URL_TTL_SECONDS * 1000 - REFRESH_MARGIN_MS,
      });
      return data.signedUrl;
    } catch {
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, task);
  return task;
}

/** Resolve a stored address to something an `<img>` can load. */
export async function resolveMediaUrl(value?: string | null): Promise<string | undefined> {
  if (!value) return undefined;
  const commentKey = privateCommentMediaKey(value);
  if (commentKey) {
    try {
      const sdk = getSupabase();
      const before = (await sdk.auth.getSession()).data.session?.user.id;
      if (!before) return undefined;
      const { data, error } = await sdk.storage.from("findback-comment-media").createSignedUrl(commentKey, 60);
      const after = (await sdk.auth.getSession()).data.session?.user.id;
      return !error && before === after ? data?.signedUrl : undefined;
    } catch { return undefined; }
  }
  if (!isPrivateMediaKey(value)) return value;
  // A fresh cached URL is the answer: re-signing per consumer would turn one
  // page of photos into one Storage round trip each.
  const cached = peekMediaUrl(value);
  if (cached) return cached;
  return (await signOne(value)) ?? undefined;
}

/**
 * React view of {@link resolveMediaUrl}.
 *
 * A non-key value is returned during the very first render (no extra commit and
 * no loading flicker for legacy rows or a cover that arrives with its row); an
 * already-cached key is returned the same way. Only a key that has never been
 * signed costs one extra render, and it falls back to the raw key when signing
 * fails, so the element's own error state (and the existing "Photo
 * unavailable" surface) still runs instead of shimmering forever.
 */
export function useMediaUrl(value?: string | null): string | undefined {
  // Remembers WHICH key was signed: a resolved URL must never be painted for a
  // later, different value (a report card re-used for another report).
  const [signed, setSigned] = useState<{ key: string; url: string | undefined } | null>(null);

  useEffect(() => {
    if (!value || !isPrivateMediaKey(value)) return;
    if (peekMediaUrl(value)) return;
    const key = value;
    let live = true;
    let generation = 0;
    const comment = !!privateCommentMediaKey(key);
    const refresh = () => {
      const current = ++generation;
      void resolveMediaUrl(key).then((url) => {
        if (live && current === generation) setSigned({ key, url: url ?? (comment ? undefined : key) });
      });
    };
    refresh();
    const timer = comment ? window.setInterval(refresh, 45_000) : undefined;
    const subscription = comment ? getSupabase().auth.onAuthStateChange(() => {
      ++generation;
      setSigned(null);
      // Do not make SDK calls inside its synchronous auth callback lock.
      queueMicrotask(() => { if (live) refresh(); });
    }).data.subscription : undefined;
    return () => {
      live = false;
      ++generation;
      window.clearInterval(timer);
      subscription?.unsubscribe();
    };
  }, [value]);

  if (!value) return undefined;
  if (!isPrivateMediaKey(value)) return value;
  return peekMediaUrl(value) ?? (signed?.key === value ? signed.url : undefined);
}
