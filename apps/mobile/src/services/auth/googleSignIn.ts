/**
 * W0-B (S2) — Google ID-token service seam.
 *
 * Consumes the native bridge token (S1, W0-A-owned) and signs in through the
 * EXISTING Supabase client + session owner. No second session store.
 *
 * Outcomes:
 * - existing FindBack profile (including identity-linked same-email password
 *   accounts) → `authenticated`, profile preserved untouched;
 * - valid session but no public.users row (the trigger skips creation when
 *   username+phone metadata are absent) → `needsProfile` with an editable
 *   SEED, session KEPT (never signed out for this);
 * - provider/SDK failures → human ApiError messages, never raw internals.
 *
 * Google-supplied phone is PREFILL ONLY: it never derives `phoneVerified`
 * (fetchMe semantics are unchanged). Google avatar URLs persist only when
 * they point at Google hosts, else null. The idToken is never logged.
 */
import type { PublicUser } from "@findback/shared";
import { Capacitor } from "@capacitor/core";
import { getSupabase } from "../supabaseClient";
import { ApiError, setToken } from "../session";
import { fetchMe } from "../auth";
import { isGoogleAuthAvailable } from "../../native/googleAuth";
import { AUTH_CALLBACK_PATH, isAllowedAuthOrigin } from "../../utils/authRedirect";
import { isSafeInternalRoute, rememberAuthReturnTo } from "../../utils/authReturnTo";

/** Same username syntax the registration trigger enforces. */
const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,20}$/;

/** Bangladesh mobile rule shared with the auth trigger + phone forms. */
const BD_PHONE_PATTERN = /^(\+?88)?01[3-9][0-9]{8}$/;

/**
 * Google-hosted avatar persistence allowlist. Anything else persists as null
 * (never an arbitrary remote URL).
 */
const GOOGLE_AVATAR_HOST_PATTERN = /(^|\.)googleusercontent\.com$/i;

const MAX_AVATAR_URL_LENGTH = 2048;
const MAX_DISPLAY_NAME_LENGTH = 80;

export interface GoogleProfileSeed {
  email: string;
  /** Display-name SEED only. Never treated as identity. */
  name: string | null;
  /** Avatar SEED only (Google host or null). Persistence allowlists Google hosts. */
  avatarUrl: string | null;
  /** Verified-phone prefill ONLY ("" when not provided). Never proof. */
  phone: string;
  /** Local suggestion, NOT claimed — completion UI checks via checkUsername. */
  suggestedUsername: string;
}

export type GoogleSignInOutcome =
  | { status: "authenticated"; user: PublicUser }
  | { status: "needsProfile"; seed: GoogleProfileSeed };

/**
 * Narrow missing-row check (PostgREST PGRST116 on the users lookup).
 * Code-only — never message-string matching.
 */
export function isProfileMissingError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (err as { code?: unknown }).code === "PGRST116";
}

function normalizeCandidate(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 20)
    .replace(/_+$/g, "");
}

/**
 * Local username suggestion from a Google name or email local-part.
 * Normalized against the username pattern; availability is NOT claimed —
 * the completion UI must check via checkUsername before finalizing.
 */
export function suggestUsername(name: string | null, email: string): string {
  const localPart = email.split("@")[0] ?? "";
  const candidates = [name ?? "", localPart, `${name ?? ""}_${localPart}`];
  for (const raw of candidates) {
    const candidate = normalizeCandidate(raw);
    if (USERNAME_PATTERN.test(candidate)) return candidate;
  }
  return "findback_user";
}

function sanitizeAvatarUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_AVATAR_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!GOOGLE_AVATAR_HOST_PATTERN.test(url.hostname)) return null;
  return trimmed;
}

interface BridgeAuthUser {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
}

function metadataString(meta: Record<string, unknown>, key: string): string | null {
  const value = meta[key];
  return typeof value === "string" ? value : null;
}

function seedFromAuthUser(authUser: BridgeAuthUser): GoogleProfileSeed {
  const meta = authUser.user_metadata ?? {};
  const email = typeof authUser.email === "string" ? authUser.email : "";
  const name = metadataString(meta, "name") ?? metadataString(meta, "full_name");
  const avatarUrl = sanitizeAvatarUrl(meta["avatar_url"] ?? meta["picture"] ?? null);
  const phone = metadataString(meta, "phone") ?? "";
  return { email, name, avatarUrl, phone, suggestedUsername: suggestUsername(name, email) };
}

function mapGoogleSignInError(error: { message?: string; code?: string; status?: number }): ApiError {
  const code = error.code ?? "";
  const message = (error.message ?? "").toLowerCase();
  if (
    code === "over_request_rate_limit" ||
    message.includes("rate limit") ||
    message.includes("too many requests")
  ) {
    return new ApiError("Too many attempts. Please wait a moment and try again.", 429);
  }
  if (
    code === "provider_disabled" ||
    code === "validation_failed" ||
    (message.includes("provider") && message.includes("disabled")) ||
    message.includes("unsupported provider")
  ) {
    return new ApiError("Google sign-in is not available right now. Please try again later.", 503);
  }
  return new ApiError("Google sign-in failed. Please try again.", error.status ?? 400);
}

/**
 * Resolve the completion seed for the CURRENT session: non-null only when a
 * session is valid AND its public.users row is missing (new Google account or
 * interrupted completion). Narrow PGRST116 probe — no message matching.
 */
export async function getNeedsProfileSeed(): Promise<GoogleProfileSeed | null> {
  const {
    data: { user },
  } = await getSupabase().auth.getUser();
  if (!user) return null;
  const probe = await getSupabase().from("users").select("id").eq("id", user.id).single();
  if (probe.error) {
    if (!isProfileMissingError(probe.error)) return null;
    return seedFromAuthUser(user as BridgeAuthUser);
  }
  return null;
}

/**
 * Sign in with a Google ID token from the native bridge (S1).
 * Uses the existing client + setToken; no second session store.
 *
 * `nonce` is the RAW single-use nonce generated natively (S1 `nonce` field):
 * the hashed form went to Google as the ID-option nonce, and Supabase
 * verifies SHA-256(raw) against the token's nonce claim server-side with
 * skip-nonce-check OFF. Never logged.
 */
export async function signInWithGoogleIdToken(idToken: string, nonce: string): Promise<GoogleSignInOutcome> {
  if (!idToken) throw new ApiError("Google sign-in failed. Please try again.", 400);
  if (!nonce) throw new ApiError("Google sign-in failed. Please try again.", 400);
  const { data, error } = await getSupabase().auth.signInWithIdToken({
    provider: "google",
    token: idToken,
    nonce,
  });
  if (error) throw mapGoogleSignInError(error);
  if (!data.session) throw new ApiError("Google sign-in failed. Please try again.", 400);
  setToken(data.session.access_token);
  return resolveOutcomeForCurrentSession();
}

/**
 * ONE resolver shared by both entry points (native ID-token exchange and web
 * OAuth callback): a valid Supabase Google session is either an existing
 * FindBack profile (authenticated) or a session with no `public.users` row
 * (needsProfile, session KEPT). A password-created profile is never overwritten
 * — this only reads.
 */
async function resolveOutcomeForCurrentSession(): Promise<GoogleSignInOutcome> {
  try {
    return { status: "authenticated", user: await fetchMe() };
  } catch (err) {
    const seed = await getNeedsProfileSeed().catch(() => null);
    if (seed) return { status: "needsProfile", seed };
    throw err;
  }
}

/**
 * Resolve the CURRENT stored session into an outcome (used right after the web
 * OAuth callback has been exchanged). Throws when there is no session.
 */
export async function resolveCurrentGoogleSessionOutcome(): Promise<GoogleSignInOutcome> {
  const { data } = await getSupabase().auth.getSession();
  const session = data?.session ?? null;
  if (!session) throw new ApiError("Google sign-in didn't complete. Please try again.", 400);
  setToken(session.access_token);
  return resolveOutcomeForCurrentSession();
}

/** Which Google strategy this runtime should use. */
export type GoogleAuthStrategy = "android-native" | "web-oauth" | "unavailable";

export interface GoogleStrategyDeps {
  nativeAvailable: () => boolean;
  isBrowser: () => boolean;
  supabaseConfigured: () => boolean;
}

const DEFAULT_STRATEGY_DEPS: GoogleStrategyDeps = {
  nativeAvailable: () => isGoogleAuthAvailable(),
  isBrowser: () => !Capacitor.isNativePlatform(),
  supabaseConfigured: () => {
    try {
      getSupabase();
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * The Android Credential Manager native flow wins on Android; otherwise a
 * browser with a configured Supabase client uses the web OAuth flow; anything
 * else is unavailable (button hidden). Never throws.
 */
export function googleAuthStrategy(deps: GoogleStrategyDeps = DEFAULT_STRATEGY_DEPS): GoogleAuthStrategy {
  try {
    if (deps.nativeAvailable()) return "android-native";
  } catch {
    /* fall through */
  }
  try {
    if (deps.isBrowser() && deps.supabaseConfigured()) return "web-oauth";
  } catch {
    /* fall through */
  }
  return "unavailable";
}

/** Absolute OAuth callback URL for the current browser origin. */
export function googleOAuthRedirectTo(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${AUTH_CALLBACK_PATH}`;
}

/**
 * Browser Google sign-in: hands off to Supabase `signInWithOAuth` (the Google
 * client id/secret live in the Supabase provider config — never in the web
 * bundle). The browser navigates away; the outcome is resolved by the
 * `/auth/callback` bridge. `returnTo` must be a safe internal route.
 */
export async function signInWithGoogleWebOAuth(opts: { returnTo?: string | null } = {}): Promise<void> {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  if (!origin || !isAllowedAuthOrigin(origin)) {
    throw new ApiError("Google sign-in isn't available on this site.", 400);
  }
  if (opts.returnTo && isSafeInternalRoute(opts.returnTo)) rememberAuthReturnTo(opts.returnTo);
  const { error } = await getSupabase().auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: googleOAuthRedirectTo(origin),
      skipBrowserRedirect: false,
      queryParams: { prompt: "select_account" },
    },
  });
  if (error) throw mapGoogleSignInError(error);
}

/**
 * Finish the browser OAuth callback: exchange the PKCE code for a session, then
 * resolve the shared outcome. The code is single-use and never logged.
 */
export async function completeGoogleWebCallback(code: string): Promise<GoogleSignInOutcome> {
  const clean = (code ?? "").trim();
  if (!clean) throw new ApiError("Google sign-in didn't complete. Please try again.", 400);
  const { data, error } = await getSupabase().auth.exchangeCodeForSession(clean);
  if (error) throw mapGoogleSignInError(error);
  if (!data.session) throw new ApiError("Google sign-in didn't complete. Please try again.", 400);
  setToken(data.session.access_token);
  return resolveOutcomeForCurrentSession();
}

function mapCompletionError(error: { message?: string; code?: string; status?: number }): ApiError {
  const code = error.code ?? "";
  const message = (error.message ?? "").toLowerCase();
  if (
    code === "23505" ||
    message.includes("duplicate key") ||
    message.includes("unique constraint") ||
    message.includes("already exists")
  ) {
    return new ApiError("An account with these details already exists.", 409);
  }
  if (message.includes("invalid username")) {
    return new ApiError("Enter a valid username (3–20 letters, numbers, or underscores).", 400);
  }
  if (message.includes("invalid phone")) {
    return new ApiError("Enter a valid Bangladesh mobile number (e.g., 01812345678).", 400);
  }
  if (message.includes("display name")) {
    return new ApiError("Enter your name (up to 80 characters).", 400);
  }
  if (code === "28000" || message.includes("not authenticated") || message.includes("jwt")) {
    return new ApiError("Your session expired. Sign in again to finish your profile.", 401);
  }
  return new ApiError("Could not save your profile. Check your connection and try again.", error.status ?? 400);
}

/**
 * Finalize a missing social profile via the staged `complete_social_profile`
 * RPC (single insert, on conflict(id) do nothing — an existing profile is
 * never overwritten). Returns the created profile via fetchMe().
 */
export async function completeSocialProfile(input: {
  username: string;
  displayName: string;
  phone: string;
  avatarUrl: string | null;
}): Promise<PublicUser> {
  const username = input.username.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(username)) {
    throw new ApiError("Enter a valid username (3–20 letters, numbers, or underscores).", 400);
  }
  const displayName = input.displayName.trim();
  if (!displayName || displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new ApiError("Enter your name (up to 80 characters).", 400);
  }
  const phone = input.phone.trim();
  if (!BD_PHONE_PATTERN.test(phone)) {
    throw new ApiError("Enter a valid Bangladesh mobile number (e.g., 01812345678).", 400);
  }
  const { error } = await getSupabase().rpc("complete_social_profile", {
    p_username: username,
    p_phone: phone,
    p_display_name: displayName,
    p_avatar_url: sanitizeAvatarUrl(input.avatarUrl),
  });
  if (error) throw mapCompletionError(error);
  return fetchMe();
}
