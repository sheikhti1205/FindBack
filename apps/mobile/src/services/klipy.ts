/**
 * C3 KLIPY GIF/Sticker service adapter (comments composer).
 *
 * - Behind a config flag: `VITE_KLIPY_API_KEY` (testing key via config/env
 *   only — never hardcoded, never committed). Absent/blank → disabled and the
 *   composer hides the GIF control entirely (graceful, no error surface).
 * - Stable `customer_id`: the signed-in user's id when known
 *   (`findback:<uid>`), else a persisted random id in localStorage
 *   (`findback.klipy_customer_id`) created once and reused — Klipy asks that
 *   the value stay consistent for the same user.
 * - High content filter on every search (`content_filter=high`).
 * - Provider URLs/data preserved: results keep the original Klipy media URLs
 *   and slug; the UI loads media directly from those URLs (no proxy, no
 *   base64) and posts the same URL into the comment body.
 * - Share-tracking ONLY on post: `trackKlipyShare` is called after a comment
 *   posts successfully — never on search, preview, or picker select.
 * - Attribution: callers render `KLIPY_ATTRIBUTION` ("Powered by KLIPY").
 */

export const KLIPY_API_BASE = "https://api.klipy.com/api/v1";
export const KLIPY_ATTRIBUTION = "Powered by KLIPY";
export const KLIPY_ATTRIBUTION_URL = "https://klipy.com";
/** Placeholder text for the Klipy search field. */
export const KLIPY_SEARCH_PLACEHOLDER = "Search KLIPY";
export const KLIPY_CONTENT_FILTER = "high";
const CUSTOMER_ID_STORAGE_KEY = "findback.klipy_customer_id";

export type KlipyKind = "gifs" | "stickers";

export interface KlipyItem {
  kind: KlipyKind;
  /** Provider slug (stable id for share-tracking). Preserved verbatim. */
  slug: string;
  title: string;
  /** Direct provider media URL (full gif/sticker). Loaded directly, never proxied. */
  mediaUrl: string;
  /** Direct provider preview URL (still/preview). Falls back to mediaUrl. */
  previewUrl: string;
  width?: number;
  height?: number;
  /** Raw provider payload, preserved for forward-compat (never rendered). */
  raw: unknown;
}

function readEnv(key: string): string {
  try {
    const value = (import.meta.env[key] as string | undefined) ?? undefined;
    return (value ?? "").trim();
  } catch {
    return "";
  }
}

/** Testing/prod app key from config only. Blank → the adapter is disabled. */
export function klipyAppKey(env?: Record<string, string | undefined>): string {
  if (env) return (env.VITE_KLIPY_API_KEY ?? "").trim();
  return readEnv("VITE_KLIPY_API_KEY");
}

export function isKlipyEnabled(env?: Record<string, string | undefined>): boolean {
  return klipyAppKey(env) !== "";
}

function randomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `anon-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  }
}

/**
 * Stable per-device/per-user customer id. Prefers the signed-in user id so
 * the value is stable across devices; otherwise a once-generated anonymous
 * id persisted in localStorage. Never regenerates per request.
 */
export function klipyCustomerId(userId?: string | null): string {
  const uid = (userId ?? "").trim();
  if (uid !== "") return `findback:${uid}`;
  try {
    const ls = globalThis.localStorage;
    const existing = ls?.getItem(CUSTOMER_ID_STORAGE_KEY);
    if (existing && existing.trim() !== "") return existing;
    const fresh = `findback-anon:${randomId()}`;
    try {
      ls?.setItem(CUSTOMER_ID_STORAGE_KEY, fresh);
    } catch {
      // Persistence is best-effort; the value is still stable for the session.
    }
    return fresh;
  } catch {
    return `findback-anon:${randomId()}`;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return "";
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return undefined;
}

/**
 * Normalize one provider item, tolerating Klipy's response variants. Never
 * throws: unparseable entries resolve to null and are skipped.
 */
export function normalizeKlipyItem(kind: KlipyKind, raw: unknown): KlipyItem | null {
  const r = asRecord(raw);
  if (!r) return null;
  const slug = firstString(r.slug, r.id);
  if (slug === "") return null;
  const title = firstString(r.title, r.alt, slug);
  const media = asRecord(r.media) ?? asRecord(r.files) ?? null;
  const gif = (media ? (asRecord(media.gif) ?? asRecord(media.mp4) ?? asRecord(media.original)) : null) ?? media;
  const preview =
    firstString(
      r.preview_url, r.previewUrl, r.still_url,
      asRecord(gif)?.preview, asRecord(gif)?.still, asRecord(r.images)?.preview,
    );
  const mediaUrl = firstString(
    r.url, r.gif_url, r.gifUrl,
    asRecord(gif)?.url, asRecord(r.images)?.original, asRecord(r.images)?.gif,
  );
  if (mediaUrl === "") return null;
  return {
    kind,
    slug,
    title,
    mediaUrl,
    previewUrl: preview !== "" ? preview : mediaUrl,
    width: firstNumber(asRecord(gif)?.width, r.width),
    height: firstNumber(asRecord(gif)?.height, r.height),
    raw,
  };
}

function contentItemsOf(payload: unknown): unknown[] {
  const root = asRecord(payload);
  const candidates: unknown[] = [
    root?.data,
    asRecord(root?.data)?.content_items,
    asRecord(root?.data)?.items,
    asRecord(root?.result)?.content_items,
    root?.content_items,
    root?.items,
    root?.results,
    payload,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

export interface KlipySearchOptions {
  page?: number;
  perPage?: number;
  customerId?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}

/**
 * Search Klipy GIFs (empty query → trending). No share/view tracking here —
 * searching never reports back to the provider.
 */
export async function searchKlipyGifs(
  query: string,
  options: KlipySearchOptions = {},
): Promise<KlipyItem[]> {
  return searchKlipy("gifs", query, options);
}

/** Search Klipy stickers (empty query → trending). */
export async function searchKlipyStickers(
  query: string,
  options: KlipySearchOptions = {},
): Promise<KlipyItem[]> {
  return searchKlipy("stickers", query, options);
}

async function searchKlipy(
  kind: KlipyKind,
  query: string,
  options: KlipySearchOptions,
): Promise<KlipyItem[]> {
  const key = klipyAppKey(options.env);
  if (key === "") return [];
  const q = query.trim();
  const page = Math.max(1, options.page ?? 1);
  const perPage = Math.min(50, Math.max(1, options.perPage ?? 24));
  const customerId = options.customerId ?? klipyCustomerId();
  const endpoint = q === "" ? "trending" : "search";
  const params = new URLSearchParams({
    page: String(page),
    per_page: String(perPage),
    customer_id: customerId,
    content_filter: KLIPY_CONTENT_FILTER,
  });
  if (q !== "") params.set("q", q);
  const url = `${KLIPY_API_BASE}/${encodeURIComponent(key)}/${kind}/${endpoint}?${params.toString()}`;
  const impl = options.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await impl(url, { signal: options.signal });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    return [];
  }
  const out: KlipyItem[] = [];
  for (const raw of contentItemsOf(payload)) {
    const item = normalizeKlipyItem(kind, raw);
    if (item) out.push(item);
  }
  return out;
}

/**
 * Share-tracking: report that a Klipy item was posted. Call ONLY after the
 * comment posts successfully. Fire-and-forget — never throws, never blocks
 * the composer on failure.
 */
export async function trackKlipyShare(
  kind: KlipyKind,
  slug: string,
  customerId: string,
  opts: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> } = {},
): Promise<void> {
  const key = klipyAppKey(opts.env);
  if (key === "" || slug.trim() === "") return;
  const url = `${KLIPY_API_BASE}/${encodeURIComponent(key)}/${kind}/share/${encodeURIComponent(slug.trim())}?customer_id=${encodeURIComponent(customerId)}`;
  try {
    const impl = opts.fetchImpl ?? fetch;
    await impl(url, { method: "POST" });
  } catch {
    // Tracking is best-effort; a failure must never surface in the UI.
  }
}
