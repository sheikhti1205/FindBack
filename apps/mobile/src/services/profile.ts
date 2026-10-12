import type { PostItem, PublicProfile, PublicUser, SearchedProfile } from "@findback/shared";
import { normalizePhone } from "@findback/shared";
import { getSupabase } from "./supabaseClient";
import { ApiError } from "./session";
import { fetchMe } from "./auth";
import { isValidAvatarObjectKey } from "./avatar";

/**
 * Profile identity service.
 *
 * Reads a user's PUBLIC profile by username through the `public_profile_by_username`
 * RPC (safe columns only — never email/phone), and writes the signed-in user's own
 * display name / bio / location through the self-only `update_my_profile` RPC.
 *
 * `public.users` grants clients no INSERT/UPDATE/DELETE; rows stay RPC-owned, so
 * both writes go through SECURITY DEFINER functions that resolve the caller from
 * the session.
 */

export interface UpdateMyProfileInput {
  displayName: string;
  bio?: string | null;
  locationLabel?: string | null;
}

/** Row shape returned by `public_profile_by_username` (public columns only). */
interface PublicProfileRow {
  id: string;
  username: string;
  avatar_url: string | null;
  email_verified: boolean | number | null;
  phone_verified: boolean | number | null;
  display_name: string | null;
  bio: string | null;
  location_label: string | null;
  created_at: string;
}

const MAX_DISPLAY_NAME = 80;
const MAX_BIO = 280;
const MAX_LOCATION = 60;

/**
 * Minimum prefix length before the prefix-search RPC is called. Single-char
 * (and empty) prefixes short-circuit to []: they would fan out to near the
 * whole user table while adding nothing the client-side participant/owner
 * ranking doesn't already cover for short fragments.
 */
const MIN_PREFIX_SEARCH_LENGTH = 2;

/** Row shape returned by `findback_search_profiles_client` (public columns only). */
interface SearchedProfileRow {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
}

/** Maps the prefix-search row into `SearchedProfile`; never carries email/phone. */
export function mapSearchedProfileRow(row: SearchedProfileRow): SearchedProfile {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name ?? null,
    avatarUrl: row.avatar_url ?? null,
  };
}

/**
 * Prefix-search public profiles for @mention autocomplete. Trims; empty and
 * sub-threshold prefixes resolve [] without touching the backend. RPC errors
 * propagate as ApiError — never silently swallowed.
 */
export async function searchProfilesByPrefix(prefix: string): Promise<SearchedProfile[]> {
  const trimmed = prefix.trim();
  if (trimmed.length < MIN_PREFIX_SEARCH_LENGTH) return [];

  const { data, error } = await getSupabase().rpc("findback_search_profiles_client", {
    p_prefix: trimmed,
  });
  if (error) throw new ApiError("Those profiles could not be searched. Check your connection and try again.", 400);

  return ((data ?? []) as SearchedProfileRow[]).map(mapSearchedProfileRow);
}

function trimToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Maps the public RPC row into `PublicProfile`; never carries email/phone. */
export function mapPublicProfileRow(row: PublicProfileRow): PublicProfile {
  return {
    id: row.id,
    username: row.username,
    emailVerified: Boolean(row.email_verified),
    phoneVerified: Boolean(row.phone_verified),
    avatarUrl: row.avatar_url ?? null,
    createdAt: row.created_at,
    displayName: row.display_name ?? null,
    bio: row.bio ?? null,
    locationLabel: row.location_label ?? null,
  };
}

/** Public profile for a username. Throws a 404-shaped error when nobody matches. */
export async function fetchPublicProfile(username: string): Promise<PublicProfile> {
  const normalized = username.trim();
  if (!normalized) throw new ApiError("Enter a username to look up.", 400);

  const { data, error } = await getSupabase().rpc("public_profile_by_username", {
    p_username: normalized,
  });
  if (error) throw new ApiError("That profile could not be loaded. Check your connection and try again.", 400);

  const row = ((data ?? []) as PublicProfileRow[])[0];
  if (!row) throw new ApiError("That profile could not be found.", 404);
  return mapPublicProfileRow(row);
}

/**
 * Update the signed-in user's own public identity, then reload the full profile
 * so the caller can `setUser` with fresh email/phone verification state.
 */
export async function updateMyProfile(input: UpdateMyProfileInput): Promise<PublicUser> {
  const displayName = input.displayName.trim();
  const bio = trimToNull(input.bio);
  const locationLabel = trimToNull(input.locationLabel);

  if (!displayName) throw new ApiError("Enter a display name.", 400);
  if (displayName.length > MAX_DISPLAY_NAME) {
    throw new ApiError(`Display name must be ${MAX_DISPLAY_NAME} characters or fewer.`, 400);
  }
  if (bio && bio.length > MAX_BIO) {
    throw new ApiError(`Bio must be ${MAX_BIO} characters or fewer.`, 400);
  }
  if (locationLabel && locationLabel.length > MAX_LOCATION) {
    throw new ApiError(`Location must be ${MAX_LOCATION} characters or fewer.`, 400);
  }

  const { error } = await getSupabase().rpc("update_my_profile", {
    p_display_name: displayName,
    p_bio: bio,
    p_location_label: locationLabel,
  });
  if (error) throw new ApiError("Could not save your profile. Check your connection and try again.", 400);

  return fetchMe();
}

// ---------------------------------------------------------------------------
// Phone-change cooldown client (spec 25, W5-IDENTITY).
//
// The six-month replacement gate is server-authoritative: `request_phone_change`
// resolves the caller from the session and compares against the server clock,
// so a tampered device clock cannot move the outcome. These helpers only
// surface that gate — first verified phone and same-number reverification
// never wait. Live Auth/SMS challenge wiring stays LIVE-PENDING (owner-
// deferred); no OTP is sent from here.
// ---------------------------------------------------------------------------

/** Stable server marker for a held replacement gate (see spec 25). */
export const PHONE_CHANGE_COOLDOWN = "PHONE_CHANGE_COOLDOWN";

export interface PhoneChangeEligibility {
  eligible: boolean;
  eligibleAt: string | null;
  phoneVerified: boolean;
}

/** Row shape returned by `phone_change_eligibility` (self-only, server clock). */
interface PhoneEligibilityRow {
  eligible: boolean | null;
  eligible_at: string | null;
  phone_verified: boolean | null;
}

/** Row shape returned by `request_phone_change` (self-only gate). */
interface PhoneChangeGateRow {
  eligible: boolean | null;
  eligible_at: string | null;
}

/** First table row, or null when the RPC returns no rows. */
function firstGateRow<T>(data: unknown): T | null {
  const rows = (data ?? []) as T[];
  return rows[0] ?? null;
}

/**
 * Eligible date (`eligible_at=…`) embedded in a PHONE_CHANGE_COOLDOWN server
 * message, or null when the message carries no date. Pure — safe to call on
 * any error text.
 */
export function parsePhoneCooldownEligibleAt(message: string): string | null {
  const match = /PHONE_CHANGE_COOLDOWN(?:\s+eligible_at=(\S+))?/.exec(message ?? "");
  if (!match) return null;
  return match[1] ?? null;
}

/** True when `err` is the server's held-gate rejection (any shape). */
export function isPhoneChangeCooldownError(err: unknown): boolean {
  if (typeof err === "string") return err.includes(PHONE_CHANGE_COOLDOWN);
  if (err instanceof Error) return err.message.includes(PHONE_CHANGE_COOLDOWN);
  const message = (err as { message?: unknown } | null)?.message;
  return typeof message === "string" && message.includes(PHONE_CHANGE_COOLDOWN);
}

/**
 * Human date fragment for an eligible-at timestamp (`"on 12 April 2027"`),
 * or "" when missing/unparseable — callers fall back to dateless copy so no
 * fake countdown is ever shown.
 */
export function formatPhoneChangeEligibleAt(eligibleAt: string | null | undefined): string {
  if (!eligibleAt) return "";
  const date = new Date(eligibleAt);
  if (Number.isNaN(date.getTime())) return "";
  return `on ${date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}`;
}

/**
 * Read the signed-in account's replacement-gate state (server clock).
 * Transport failures map to a human error — never a fabricated date.
 */
export async function fetchPhoneChangeEligibility(): Promise<PhoneChangeEligibility> {
  const { data, error } = await getSupabase().rpc("phone_change_eligibility");
  if (error) {
    throw new ApiError("Could not check your number change status. Check your connection and try again.", 400);
  }
  const row = firstGateRow<PhoneEligibilityRow>(data);
  return {
    eligible: row?.eligible ?? true,
    eligibleAt: row?.eligible_at ?? null,
    phoneVerified: Boolean(row?.phone_verified),
  };
}

/**
 * Ask the server gate whether `phone` may replace the verified number.
 * Resolves the eligibility on success; rejects with a 409 naming the
 * eligible date while the gate holds. Sends no SMS — the Auth challenge
 * itself stays LIVE-PENDING.
 */
export async function requestPhoneChange(phone: string): Promise<PhoneChangeEligibility> {
  const normalized = normalizePhone(phone);
  if (!normalized) {
    throw new ApiError("Enter a valid Bangladesh mobile number (e.g., 01812345678).", 400);
  }
  const { data, error } = await getSupabase().rpc("request_phone_change", {
    p_new_phone: normalized,
  });
  if (error) {
    const message = (error as { message?: string }).message ?? "";
    if (message.includes(PHONE_CHANGE_COOLDOWN)) {
      const when = formatPhoneChangeEligibleAt(parsePhoneCooldownEligibleAt(message));
      // The mapped 409 is the cooldown signal for consumers — status-only
      // detection. The internal marker is deliberately NOT copied into the
      // user-facing message (never shown on a consumer surface); the human
      // copy names the eligible date instead.
      throw new ApiError(
        when
          ? `You can change your mobile number ${when}.`
          : "You cannot change your mobile number yet. Try again later.",
        409,
      );
    }
    throw new ApiError("Could not start your number change. Check your connection and try again.", 400);
  }
  const row = firstGateRow<PhoneChangeGateRow>(data);
  return { eligible: true, eligibleAt: row?.eligible_at ?? null, phoneVerified: false };
}

// ---------------------------------------------------------------------------
// Public-reports pagination client parts (W5-IDENTITY).
//
// PublicProfile pages a member's reports through the existing feed API one
// cursor at a time. These pure helpers keep that traversal honest: `hasMore`
// is driven only by the server cursor (never a local count), and appends
// dedupe by report id so a repeated cursor can never duplicate rows.
// ---------------------------------------------------------------------------

/** One server page of a member's public reports (FeedPage subset). */
export interface PublicReportsPage {
  items: PostItem[];
  nextCursor: string | null;
}

/** True only when the server handed a non-empty cursor for the next page. */
export function hasMoreReports(page: PublicReportsPage): boolean {
  return page.nextCursor !== null && page.nextCursor !== "";
}

/** Append a page, dropping rows already present (by id). Never mutates. */
export function appendReportPage(previous: PostItem[], page: PublicReportsPage): PostItem[] {
  if (page.items.length === 0) return previous;
  const seen = new Set(previous.map((item) => item.id));
  const fresh = page.items.filter((item) => !seen.has(item.id));
  if (fresh.length === 0) return previous;
  return [...previous, ...fresh];
}

// ---------------------------------------------------------------------------
// Avatar object-key surface for profile screens (W5-IDENTITY).
//
// Profile/account surfaces check key ownership without importing the upload
// service directly. The canonical validator lives in `./avatar` (mirroring
// `update_my_avatar_by_key` server-side); the server re-checks and verifies
// Storage existence, so a client slip can never persist.
// ---------------------------------------------------------------------------

/** True when `objectKey` is exactly `avatars/{uid}/{filename}` (own uid). */
export function isOwnAvatarKey(objectKey: string, uid: string): boolean {
  return isValidAvatarObjectKey(objectKey, uid);
}
