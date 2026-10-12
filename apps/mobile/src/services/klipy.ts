/**
 * C3 KLIPY GIF/Sticker service adapter (comments composer).
 *
 * Contract (spec 24, FBX-015/016):
 * - Live KLIPY docs were unreachable from the implementation sandbox on
 *   2026-10-12 (network-blocked fetch of klipy.com/api), so the wire
 *   contract below is implemented to spec 24 against OFFICIAL-SHAPED,
 *   SANITIZED fixtures (see klipy.test.ts `OFFICIAL_SHAPED_*`): key-scoped
 *   path segments, `page`/`per_page`/`customer_id`/`content_filter` query
 *   params, `search` vs `trending` endpoints, a `data.content_items` nesting
 *   with bounded backwards tolerance, and POST share-tracking. Revalidate
 *   against the live docs before enabling with a production key; the
 *   fixtures are clearly marked so a contract drift is caught by tests.
 * - Behind a config flag: `VITE_KLIPY_API_KEY` (testing key via config/env
 *   only — never hardcoded, never committed, never logged). Absent/blank →
 *   disabled and the composer hides the GIF control entirely (graceful, no
 *   error surface).
 * - Stable `customer_id`: the signed-in user's id when known
 *   (`findback:<uid>`), else a persisted random id in localStorage
 *   (`findback.klipy_customer_id`) created once and reused — Klipy asks that
 *   the value stay consistent for the same user.
 * - High content filter on every search (`content_filter=high`).
 * - Provider URLs allowlisted: only `https://klipy.com` and
 *   `https://*.klipy.com` survive normalization, so a malformed provider
 *   response cannot inject an arbitrary media URL into the composer.
 * - Provider URLs/data preserved: results keep the original Klipy media URLs
 *   and slug; the UI loads media directly from those URLs (no proxy, no
 *   base64) and posts the same URL into the comment body.
 * - Share-tracking ONLY on post: `trackKlipyShare` is called after a comment
 *   posts successfully — never on search, preview, or picker select.
 *   `buildKlipyShareRequest` is the pure, testable request builder behind it.
 * - Search UX state machine: `createKlipySearchController` owns debounce,
 *   latest-request-wins, stale-request cancellation, trending-on-empty,
 *   pagination, and loading/ready/error states for the picker.
 * - Attribution: callers render `KLIPY_ATTRIBUTION` ("Powered by KLIPY").
 */

export const KLIPY_API_BASE = "https://api.klipy.com/api/v1";
export const KLIPY_ATTRIBUTION = "Powered by KLIPY";
export const KLIPY_ATTRIBUTION_URL = "https://klipy.com";
/** Placeholder text for the Klipy search field. */
export const KLIPY_SEARCH_PLACEHOLDER = "Search KLIPY";
export const KLIPY_CONTENT_FILTER = "high";
/** Build-config seam: the single env key that enables the adapter. */
export const KLIPY_BUILD_CONFIG_KEY = "VITE_KLIPY_API_KEY";
/** Default debounce for picker search keystrokes (ms). */
export const KLIPY_SEARCH_DEBOUNCE_MS = 300;
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
  if (env) return (env[KLIPY_BUILD_CONFIG_KEY] ?? "").trim();
  return readEnv(KLIPY_BUILD_CONFIG_KEY);
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
 * Provider URL allowlist (spec 24 URL safety). Only `https://klipy.com` and
 * `https://*.klipy.com` are trusted provider media origins — the same rule
 * the comment gallery enforces at render time (`commentMediaProvenance`),
 * mirrored here so a malformed provider response cannot inject an arbitrary
 * media URL at intake either. Pure and total: never throws.
 */
export function isKlipyMediaUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return host === "klipy.com" || host.endsWith(".klipy.com");
}

/**
 * Normalize one provider item, tolerating Klipy's response variants. Never
 * throws: unparseable entries resolve to null and are skipped. Entries whose
 * media URL is not allowlisted (`isKlipyMediaUrl`) are rejected — a provider
 * payload can never smuggle an arbitrary host into the composer. The preview
 * URL must be allowlisted too, otherwise it falls back to the media URL.
 */
export function normalizeKlipyItem(kind: KlipyKind, raw: unknown): KlipyItem | null {
  const r = asRecord(raw);
  if (!r) return null;
  const slug = firstString(r.slug, r.id);
  if (slug === "") return null;
  const title = firstString(r.title, r.alt, slug);
  const media = asRecord(r.media) ?? asRecord(r.files) ?? null;
  const gif = (media ? (asRecord(media.gif) ?? asRecord(media.mp4) ?? asRecord(media.original)) : null) ?? media;
  const mediaUrl = firstString(
    r.url, r.gif_url, r.gifUrl,
    asRecord(gif)?.url, asRecord(r.images)?.original, asRecord(r.images)?.gif,
  );
  if (mediaUrl === "" || !isKlipyMediaUrl(mediaUrl)) return null;
  const previewCandidate = firstString(
    r.preview_url, r.previewUrl, r.still_url,
    asRecord(gif)?.preview, asRecord(gif)?.still, asRecord(r.images)?.preview,
  );
  const preview = previewCandidate !== "" && isKlipyMediaUrl(previewCandidate) ? previewCandidate : mediaUrl;
  return {
    kind,
    slug,
    title,
    mediaUrl,
    previewUrl: preview,
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

/** Pure share-tracking request (no network, no key logging — for tests/callers). */
export interface KlipyShareRequest {
  url: string;
  method: "POST";
}

/**
 * Build the POST share-tracking request for a posted Klipy item. Pure:
 * returns null when tracking must not fire (no key, blank slug, blank
 * customer id). The key travels in the path per the provider contract — it
 * is never written to logs/diagnostics (lint bans `console` in app source).
 */
export function buildKlipyShareRequest(
  kind: KlipyKind,
  slug: string,
  customerId: string,
  env?: Record<string, string | undefined>,
): KlipyShareRequest | null {
  const key = klipyAppKey(env);
  const cleanSlug = slug.trim();
  const cleanCustomer = customerId.trim();
  if (key === "" || cleanSlug === "" || cleanCustomer === "") return null;
  const url = `${KLIPY_API_BASE}/${encodeURIComponent(key)}/${kind}/share/${encodeURIComponent(cleanSlug)}?customer_id=${encodeURIComponent(cleanCustomer)}`;
  return { url, method: "POST" };
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
  const request = buildKlipyShareRequest(kind, slug, customerId, opts.env);
  if (!request) return;
  try {
    const impl = opts.fetchImpl ?? fetch;
    await impl(request.url, { method: request.method });
  } catch {
    // Tracking is best-effort; a failure must never surface in the UI.
  }
}

/** Picker search state owned by `createKlipySearchController`. */
export type KlipySearchStatus = "idle" | "loading" | "ready" | "error";
export interface KlipySearchState {
  status: KlipySearchStatus;
  tab: KlipyKind;
  query: string;
  items: KlipyItem[];
  /** 1-based page of `items`; `more()` appends page N+1. */
  page: number;
  /** Consumer-safe error copy when `status` is `error`; null otherwise. */
  error: string | null;
}

const KLIPY_SEARCH_ERROR_COPY = "Couldn't load GIFs. Check your connection and try again.";

export interface KlipySearchControllerOptions {
  debounceMs?: number;
  perPage?: number;
  /** Stable customer id, or a thunk resolving it at fire time (user may load late). */
  customerId?: string | (() => string);
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  /** Injectable search fns (default: the adapter's own). Throwing fakes surface `error`. */
  searchGifs?: typeof searchKlipyGifs;
  searchStickers?: typeof searchKlipyStickers;
  onState?: (state: KlipySearchState) => void;
}

export interface KlipySearchController {
  /** Debounced, latest-wins search (empty query → trending, page reset to 1). */
  search(query: string, tab: KlipyKind): void;
  /** Next page of the current query/tab, appended (no-op unless `ready`). */
  more(): void;
  /** Drop any pending/in-flight search (picker closed, tab switched). */
  cancel(): void;
  dispose(): void;
  getState(): KlipySearchState;
}

/**
 * Debounced, latest-request-wins, cancellable Klipy search for the picker.
 * Stale responses (slower first query resolving after a newer one) are
 * discarded by sequence AND by aborting the previous fetch, so rapid typing
 * never clobbers newer results and unmounting never sets state late. Paging
 * is explicit: `search` resets to page 1, `more` appends the next page.
 */
export function createKlipySearchController(
  options: KlipySearchControllerOptions = {},
): KlipySearchController {
  const debounceMs = Math.max(0, options.debounceMs ?? KLIPY_SEARCH_DEBOUNCE_MS);
  const perPage = Math.min(50, Math.max(1, options.perPage ?? 24));
  const runGifs = options.searchGifs ?? searchKlipyGifs;
  const runStickers = options.searchStickers ?? searchKlipyStickers;
  let state: KlipySearchState = { status: "idle", tab: "gifs", query: "", items: [], page: 1, error: null };
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: AbortController | null = null;
  let disposed = false;

  function emit(next: KlipySearchState) {
    state = next;
    options.onState?.(state);
  }

  function customerId(): string {
    return typeof options.customerId === "function" ? options.customerId() : (options.customerId ?? klipyCustomerId());
  }

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function abortInFlight() {
    if (inFlight !== null) {
      try {
        inFlight.abort();
      } catch {
        // Abort is best-effort.
      }
      inFlight = null;
    }
  }

  async function fire(id: number, query: string, tab: KlipyKind, page: number, append: boolean) {
    if (disposed || seq !== id) return;
    abortInFlight();
    const controller = new AbortController();
    inFlight = controller;
    const run = tab === "gifs" ? runGifs : runStickers;
    let items: KlipyItem[];
    try {
      items = await run(query, {
        page,
        perPage,
        customerId: customerId(),
        signal: controller.signal,
        fetchImpl: options.fetchImpl,
        env: options.env,
      });
    } catch (err) {
      if (disposed || seq !== id) return;
      // A stale abort is silence, not an error surface.
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError") return;
      emit({ status: "error", tab, query, items: append ? state.items : [], page, error: KLIPY_SEARCH_ERROR_COPY });
      return;
    }
    if (disposed || seq !== id) return;
    inFlight = null;
    emit({
      status: "ready",
      tab,
      query,
      items: append ? [...state.items, ...items] : items,
      page,
      error: null,
    });
  }

  return {
    search(query: string, tab: KlipyKind) {
      if (disposed) return;
      const id = ++seq;
      clearTimer();
      abortInFlight();
      emit({ status: "loading", tab, query, items: [], page: 1, error: null });
      timer = setTimeout(() => {
        timer = null;
        void fire(id, query, tab, 1, false);
      }, debounceMs);
    },
    more() {
      if (disposed || state.status !== "ready") return;
      const id = ++seq;
      clearTimer();
      const nextPage = state.page + 1;
      emit({ ...state, status: "loading", page: nextPage });
      timer = setTimeout(() => {
        timer = null;
        void fire(id, state.query, state.tab, nextPage, true);
      }, 0);
    },
    cancel() {
      seq += 1;
      clearTimer();
      abortInFlight();
    },
    dispose() {
      disposed = true;
      seq += 1;
      clearTimer();
      abortInFlight();
    },
    getState() {
      return state;
    },
  };
}
