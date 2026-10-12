import type { PublicUser } from "@findback/shared";
import { getSupabase } from "./supabaseClient";
import { ApiError } from "./session";
import { fetchMe } from "./auth";
import { IMAGES_BUCKET } from "./postsUpload";

/**
 * Profile avatar uploads.
 *
 * Path: an already-normalized still image (native `chooseNativeImage`
 * derivative on Android, `normalizeImage` output on web — the canonical
 * media pipeline in both cases, so EXIF/location metadata is stripped before
 * anything crosses the network) is uploaded to the ownership-scoped prefix
 * `avatars/{uid}/…` inside the existing public `findback-images` bucket, then
 * the self-only `update_my_avatar` RPC points the caller's `avatar_url` at
 * the new public URL (migration 20261010000000_profile_avatar).
 *
 * Invariants:
 * - clients hold NO table UPDATE privilege; the URL is written only through
 *   the SECURITY DEFINER RPC, which re-validates the storage-prefix shape
 *   server-side (self uid segment) and rejects anything else;
 * - only JPEG/PNG/WebP stills are accepted — never an arbitrary remote URL;
 * - a failed URL write removes the just-uploaded object so nothing orphans;
 * - replacing an avatar deletes the previous object best-effort AFTER the new
 *   URL is saved, so a cleanup failure can never leave the user avatarless;
 * - the avatar URL is public identity (same as display name), never a secret.
 */

export const AVATAR_BUCKET = IMAGES_BUCKET;
export const AVATAR_PREFIX = "avatars";
export const MAX_AVATAR_URL_LENGTH = 2048;

const AVATAR_MIME_TYPES: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const AVATAR_KEY_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(jpg|jpeg|png|webp)$/i;
const MAX_AVATAR_KEY_LENGTH = 512;

/** Normalized still image ready for avatar upload (canonical pipeline output). */
export interface AvatarSource {
  blob: Blob;
  mimeType: string;
  fileName: string;
}

function extensionForAvatar(mimeType: string): string | null {
  return AVATAR_MIME_TYPES[mimeType.trim().toLowerCase()] ?? null;
}

/** Storage object key for a new avatar: `avatars/{uid}/{uuid}.{ext}`. */
export function avatarObjectKey(uid: string, extension: string): string {
  return `${AVATAR_PREFIX}/${uid}/${crypto.randomUUID()}.${extension}`;
}

/**
 * True when `url` is an https URL into this bucket's `avatars/{uid}/` prefix
 * for the given uid. Client-side fast path only — the RPC re-checks
 * server-side (fail closed), so a mismatch here never reaches the backend.
 */
export function isAvatarStorageUrl(url: string, uid: string): boolean {
  const trimmed = url.trim();
  if (!trimmed || trimmed.length > MAX_AVATAR_URL_LENGTH) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  return parsed.pathname.includes(`/${AVATAR_BUCKET}/${AVATAR_PREFIX}/${uid}/`);
}

/**
 * Strict client-side check that `key` is exactly `avatars/{uid}/{filename}`
 * for the given uid: three segments, own uid segment, no traversal, sane
 * filename with a still-image extension. Mirrors the `update_my_avatar_by_key`
 * server checks (which additionally verify the Storage object exists), so a
 * mismatch here fails before the backend is touched — fail closed.
 */
export function isValidAvatarObjectKey(key: string, uid: string): boolean {
  if (!key || !uid) return false;
  const trimmed = key.trim();
  if (!trimmed || trimmed.length > MAX_AVATAR_KEY_LENGTH || trimmed.includes("..")) return false;
  const segments = trimmed.split("/");
  if (segments.length !== 3) return false;
  const [prefix, owner, file] = segments as [string, string, string];
  if (prefix !== AVATAR_PREFIX || owner !== uid || !file) return false;
  return AVATAR_KEY_FILENAME_PATTERN.test(file);
}

/**
 * Storage object key (`avatars/{uid}/file`) parsed out of one of our public
 * avatar URLs, or null when the URL is not ours (e.g. a Google-seeded avatar
 * — those live on Google hosts and must never be deleted from here).
 */
export function objectKeyFromAvatarUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  const marker = `/${AVATAR_BUCKET}/`;
  const at = parsed.pathname.indexOf(marker);
  if (at < 0) return null;
  const key = parsed.pathname.slice(at + marker.length);
  if (!key.startsWith(`${AVATAR_PREFIX}/`) || key.includes("..")) return null;
  const segments = key.split("/");
  if (segments.length !== 3 || !segments[1] || !segments[2]) return null;
  return key;
}

/**
 * Point the signed-in user's `avatar_url` at an already-uploaded owned object
 * key through `update_my_avatar_by_key` (exact-key RPC: validates the key
 * shape server-side and verifies the Storage object exists), then reload the
 * full profile so the caller can `setUser`. Client pre-validates the key, the
 * uid binding, and the URL-key embedding before touching the backend.
 */
export async function updateMyAvatarByKey(objectKey: string, avatarUrl: string): Promise<PublicUser> {
  const supabase = getSupabase();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    throw new ApiError("Sign in again to change your profile photo.", 401);
  }
  const uid = userData.user.id;

  if (!isValidAvatarObjectKey(objectKey, uid)) {
    throw new ApiError("That photo link looks invalid. Try uploading again.", 400);
  }
  const trimmedUrl = avatarUrl.trim();
  if (!trimmedUrl || trimmedUrl.length > MAX_AVATAR_URL_LENGTH) {
    throw new ApiError("That photo link looks invalid. Try uploading again.", 400);
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmedUrl);
  } catch {
    throw new ApiError("That photo link looks invalid. Try uploading again.", 400);
  }
  if (parsed.protocol !== "https:") {
    throw new ApiError("That photo link looks invalid. Try uploading again.", 400);
  }
  if (!trimmedUrl.includes(`/findback-images/${objectKey}`)) {
    throw new ApiError("That photo link looks invalid. Try uploading again.", 400);
  }

  const { error } = await supabase.rpc("update_my_avatar_by_key", {
    p_object_key: objectKey,
    p_avatar_url: trimmedUrl,
  });
  if (error) throw new ApiError("Could not save your profile photo. Check your connection and try again.", 400);

  return fetchMe();
}

/**
 * Point the signed-in user's `avatar_url` at `avatarUrl` (null clears it),
 * then reload the full profile so the caller can `setUser`.
 */
export async function updateMyAvatarUrl(avatarUrl: string | null): Promise<PublicUser> {
  if (avatarUrl !== null) {
    const trimmed = avatarUrl.trim();
    if (!trimmed || trimmed.length > MAX_AVATAR_URL_LENGTH) {
      throw new ApiError("That photo link looks invalid. Try uploading again.", 400);
    }
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new ApiError("That photo link looks invalid. Try uploading again.", 400);
    }
    if (parsed.protocol !== "https:") {
      throw new ApiError("That photo link looks invalid. Try uploading again.", 400);
    }
  }

  const { error } = await getSupabase().rpc("update_my_avatar", {
    p_avatar_url: avatarUrl,
  });
  if (error) throw new ApiError("Could not save your profile photo. Check your connection and try again.", 400);

  return fetchMe();
}

/**
 * Upload a normalized avatar image and point the profile at it. Returns the
 * reloaded profile. `previousAvatarUrl` (the user's current URL, if any) is
 * removed best-effort after the new URL is saved.
 */
export async function uploadAvatar(
  source: AvatarSource,
  previousAvatarUrl?: string | null,
): Promise<PublicUser> {
  const supabase = getSupabase();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    throw new ApiError("Sign in again to change your profile photo.", 401);
  }
  const uid = userData.user.id;

  const extension = extensionForAvatar(source.mimeType);
  if (!extension) {
    throw new ApiError("That photo type is not supported for profile photos. Pick a JPEG, PNG, or WebP photo.", 400);
  }

  const objectKey = avatarObjectKey(uid, extension);
  const { error: uploadError } = await supabase.storage
    .from(AVATAR_BUCKET)
    .upload(objectKey, source.blob, {
      contentType: source.mimeType,
      upsert: false,
    });
  if (uploadError) {
    throw new ApiError("Could not upload your photo. Check your connection and try again.", 502);
  }
  const fileUrl = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(objectKey).data.publicUrl;
  if (!isAvatarStorageUrl(fileUrl, uid)) {
    // The public URL does not look like our own avatar prefix: never persist
    // it — remove the object and fail closed.
    await supabase.storage.from(AVATAR_BUCKET).remove([objectKey]);
    throw new ApiError("Could not upload your photo. Check your connection and try again.", 502);
  }

  const { error: saveError } = await supabase.rpc("update_my_avatar", {
    p_avatar_url: fileUrl,
  });
  if (saveError) {
    await supabase.storage.from(AVATAR_BUCKET).remove([objectKey]);
    throw new ApiError("Could not save your profile photo. Check your connection and try again.", 400);
  }

  const profile = await fetchMe();

  // Replacing: drop the previous object only after the new URL is saved, and
  // never fail the (already successful) change on stale cleanup.
  const previousKey = objectKeyFromAvatarUrl(previousAvatarUrl);
  if (previousKey && previousKey !== objectKey) {
    try {
      await supabase.storage.from(AVATAR_BUCKET).remove([previousKey]);
    } catch {
      /* best-effort cleanup */
    }
  }

  return profile;
}

/**
 * Clear the signed-in user's avatar, then remove the stored object
 * best-effort. Returns the reloaded profile.
 */
export async function removeAvatar(currentAvatarUrl?: string | null): Promise<PublicUser> {
  const profile = await updateMyAvatarUrl(null);
  const key = objectKeyFromAvatarUrl(currentAvatarUrl);
  if (key) {
    try {
      await getSupabase().storage.from(AVATAR_BUCKET).remove([key]);
    } catch {
      /* best-effort cleanup */
    }
  }
  return profile;
}
