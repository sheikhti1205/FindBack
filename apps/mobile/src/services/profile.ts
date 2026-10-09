import type { PublicProfile, PublicUser, SearchedProfile } from "@findback/shared";
import { getSupabase } from "./supabaseClient";
import { ApiError } from "./session";
import { fetchMe } from "./auth";

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
