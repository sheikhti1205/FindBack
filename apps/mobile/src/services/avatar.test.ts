import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicUser } from "@findback/shared";

const { clientMock, fetchMeMock, uploadMock, removeMock, rpcMock } = vi.hoisted(() => {
    const uploadMock = vi.fn(async () => ({ error: null as { message?: string } | null }));
    const removeMock = vi.fn(async () => ({ error: null as { message?: string } | null }));
    const rpcMock = vi.fn(async () => ({ error: null as { message?: string; code?: string; status?: number } | null }));
    const getPublicUrlMock = vi.fn(
      (path: string) => ({
        data: { publicUrl: `https://ref.supabase.co/storage/v1/object/public/findback-images/${path}` },
      }),
    );
    const clientMock = {
      auth: { getUser: vi.fn() },
      storage: {
        from: vi.fn(() => ({ upload: uploadMock, remove: removeMock, getPublicUrl: getPublicUrlMock })),
      },
      rpc: rpcMock,
    };
    const fetchMeMock = vi.fn();
    return { clientMock, fetchMeMock, uploadMock, removeMock, rpcMock };
  });

vi.mock("./supabaseClient", () => ({ getSupabase: () => clientMock }));
vi.mock("./auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth")>();
  return { ...actual, fetchMe: (...args: unknown[]) => fetchMeMock(...args) };
});

import {
  AVATAR_BUCKET,
  AVATAR_PREFIX,
  avatarObjectKey,
  isAvatarStorageUrl,
  isValidAvatarObjectKey,
  objectKeyFromAvatarUrl,
  removeAvatar,
  updateMyAvatarByKey,
  updateMyAvatarUrl,
  uploadAvatar,
} from "./avatar";

const refreshed: PublicUser = {
  id: "user-1",
  username: "tester",
  email: "tester@example.com",
  phone: "+8801812345678",
  emailVerified: true,
  phoneVerified: false,
  avatarUrl: "https://ref.supabase.co/storage/v1/object/public/findback-images/avatars/user-1/new.jpg",
  displayName: "Tester",
  bio: null,
  locationLabel: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function avatarSource(mimeType = "image/jpeg") {
  return { blob: new Blob(["avatar-bytes"], { type: mimeType }), mimeType, fileName: "me.jpg" };
}

beforeEach(() => {
  vi.clearAllMocks();
  clientMock.auth.getUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
  uploadMock.mockResolvedValue({ error: null });
  removeMock.mockResolvedValue({ error: null });
  rpcMock.mockResolvedValue({ error: null });
  fetchMeMock.mockResolvedValue(refreshed);
});

describe("avatarObjectKey", () => {
  it("nests the object under avatars/{uid} with a unique name", () => {
    const first = avatarObjectKey("user-1", "jpg");
    const second = avatarObjectKey("user-1", "jpg");
    expect(first).toMatch(/^avatars\/user-1\/[0-9a-f-]{36}\.jpg$/);
    expect(second).not.toBe(first);
  });
});

describe("isAvatarStorageUrl", () => {
  const own = "https://ref.supabase.co/storage/v1/object/public/findback-images/avatars/user-1/a.jpg";

  it("accepts an https URL into the caller's own avatar prefix", () => {
    expect(isAvatarStorageUrl(own, "user-1")).toBe(true);
  });

  it("rejects another user's prefix, report paths, and non-storage URLs", () => {
    expect(
      isAvatarStorageUrl(
        "https://ref.supabase.co/storage/v1/object/public/findback-images/avatars/user-2/a.jpg",
        "user-1",
      ),
    ).toBe(false);
    expect(
      isAvatarStorageUrl("https://ref.supabase.co/storage/v1/object/public/findback-images/user-1/a.jpg", "user-1"),
    ).toBe(false);
    expect(isAvatarStorageUrl("https://lh3.googleusercontent.com/a/avatar", "user-1")).toBe(false);
    expect(isAvatarStorageUrl("http://ref.supabase.co/storage/v1/object/public/findback-images/avatars/user-1/a.jpg", "user-1")).toBe(false);
    expect(isAvatarStorageUrl("not a url", "user-1")).toBe(false);
    expect(isAvatarStorageUrl("", "user-1")).toBe(false);
  });

  it("rejects lookalike hosts carrying our exact path (FBX-022)", () => {
    const path = "/storage/v1/object/public/findback-images/avatars/user-1/a.jpg";
    // Foreign host with our path — the old substring check accepted this.
    expect(isAvatarStorageUrl(`https://evil.example.com${path}`, "user-1")).toBe(false);
    // Suffix trick: the marker host is not the URL host.
    expect(isAvatarStorageUrl(`https://ref.supabase.co.evil.com${path}`, "user-1")).toBe(false);
    // Multi-label subdomain under supabase.co is never a project ref.
    expect(isAvatarStorageUrl(`https://a.ref.supabase.co${path}`, "user-1")).toBe(false);
    // Marker buried in a query string never counts.
    expect(
      isAvatarStorageUrl(`https://evil.example.com/x?u=https://ref.supabase.co${path}`, "user-1"),
    ).toBe(false);
  });

  it("rejects wrong buckets, bare prefixes, traversal, and missing objects (FBX-022)", () => {
    expect(
      isAvatarStorageUrl(
        "https://ref.supabase.co/storage/v1/object/public/other-bucket/avatars/user-1/a.jpg",
        "user-1",
      ),
    ).toBe(false);
    // Bare prefix with no object name.
    expect(
      isAvatarStorageUrl(
        "https://ref.supabase.co/storage/v1/object/public/findback-images/avatars/user-1/",
        "user-1",
      ),
    ).toBe(false);
    // Traversal collapses out of the prefix (URL normalizes `..` away).
    expect(
      isAvatarStorageUrl(
        "https://ref.supabase.co/storage/v1/object/public/findback-images/avatars/user-1/../x.jpg",
        "user-1",
      ),
    ).toBe(false);
    // No public-object marker at all.
    expect(isAvatarStorageUrl("https://ref.supabase.co/findback-images/avatars/user-1/a.jpg", "user-1")).toBe(
      false,
    );
  });
});

describe("objectKeyFromAvatarUrl", () => {
  it("extracts the storage key from one of our avatar URLs", () => {
    expect(
      objectKeyFromAvatarUrl(
        "https://ref.supabase.co/storage/v1/object/public/findback-images/avatars/user-1/a.jpg",
      ),
    ).toBe("avatars/user-1/a.jpg");
  });

  it("returns null for Google-seeded avatars, report images, and garbage", () => {
    expect(objectKeyFromAvatarUrl("https://lh3.googleusercontent.com/a/avatar")).toBeNull();
    expect(
      objectKeyFromAvatarUrl("https://ref.supabase.co/storage/v1/object/public/findback-images/user-1/a.jpg"),
    ).toBeNull();
    expect(objectKeyFromAvatarUrl(null)).toBeNull();
    expect(objectKeyFromAvatarUrl(undefined)).toBeNull();
    expect(objectKeyFromAvatarUrl("not a url")).toBeNull();
    expect(
      objectKeyFromAvatarUrl("https://ref.supabase.co/storage/v1/object/public/findback-images/avatars/user-1/../x.jpg"),
    ).toBeNull();
  });
});

describe("updateMyAvatarUrl", () => {
  it("writes through the self-only avatar RPC then reloads the profile", async () => {
    const url = "https://ref.supabase.co/storage/v1/object/public/findback-images/avatars/user-1/a.jpg";

    const result = await updateMyAvatarUrl(url);

    expect(rpcMock).toHaveBeenCalledWith("update_my_avatar", { p_avatar_url: url });
    expect(fetchMeMock).toHaveBeenCalledTimes(1);
    expect(result).toBe(refreshed);
  });

  it("clears the avatar with null", async () => {
    await updateMyAvatarUrl(null);

    expect(rpcMock).toHaveBeenCalledWith("update_my_avatar", { p_avatar_url: null });
    expect(fetchMeMock).toHaveBeenCalledTimes(1);
  });

  it("rejects non-https and overlong URLs before touching the backend", async () => {
    await expect(updateMyAvatarUrl("http://cdn.example.com/a.jpg")).rejects.toThrow(/invalid/i);
    await expect(updateMyAvatarUrl("not a url")).rejects.toThrow(/invalid/i);
    await expect(updateMyAvatarUrl(`https://cdn.example.com/${"a".repeat(2048)}`)).rejects.toThrow();
    expect(rpcMock).not.toHaveBeenCalled();
    expect(fetchMeMock).not.toHaveBeenCalled();
  });

  it("maps RPC failures to a human save error without reloading", async () => {
    rpcMock.mockResolvedValue({ error: { message: "invalid avatar url" } });

    await expect(updateMyAvatarUrl("https://ref.supabase.co/x.jpg")).rejects.toThrow(
      /could not save your profile photo/i,
    );
    expect(fetchMeMock).not.toHaveBeenCalled();
  });
});

describe("uploadAvatar", () => {
  it("uploads the normalized still under avatars/{uid}, saves the URL, and reloads", async () => {
    const result = await uploadAvatar(avatarSource());

    expect(uploadMock).toHaveBeenCalledWith(
      expect.stringMatching(/^avatars\/user-1\/[0-9a-f-]{36}\.jpg$/),
      expect.any(Blob),
      { contentType: "image/jpeg", upsert: false },
    );
    expect(clientMock.storage.from).toHaveBeenCalledWith(AVATAR_BUCKET);
    expect(rpcMock).toHaveBeenCalledWith("update_my_avatar_by_key", {
      p_object_key: expect.stringMatching(/^avatars\/user-1\/[0-9a-f-]{36}\.jpg$/),
      p_avatar_url: expect.stringMatching(
        /^https:\/\/ref\.supabase\.co\/storage\/v1\/object\/public\/findback-images\/avatars\/user-1\//,
      ),
    });
    expect(fetchMeMock).toHaveBeenCalledTimes(1);
    expect(result).toBe(refreshed);
  });

  it("maps png/webp to their extensions and refuses gif", async () => {
    await uploadAvatar(avatarSource("image/png"));
    expect(uploadMock).toHaveBeenLastCalledWith(
      expect.stringMatching(/\.png$/),
      expect.any(Blob),
      expect.anything(),
    );

    await uploadAvatar(avatarSource("image/webp"));
    expect(uploadMock).toHaveBeenLastCalledWith(
      expect.stringMatching(/\.webp$/),
      expect.any(Blob),
      expect.anything(),
    );

    await expect(uploadAvatar(avatarSource("image/gif"))).rejects.toThrow(/not supported/i);
    expect(rpcMock).toHaveBeenCalledTimes(2);
  });

  it("refuses to upload without a session", async () => {
    clientMock.auth.getUser.mockResolvedValue({ data: { user: null }, error: null });

    await expect(uploadAvatar(avatarSource())).rejects.toThrow(/sign in again/i);
    expect(uploadMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("removes the just-uploaded object when saving the URL fails", async () => {
    rpcMock.mockResolvedValue({ error: { message: "invalid avatar url" } });

    await expect(uploadAvatar(avatarSource())).rejects.toThrow(/could not save/i);

    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(removeMock).toHaveBeenCalledWith([
      expect.stringMatching(/^avatars\/user-1\/[0-9a-f-]{36}\.jpg$/),
    ]);
    expect(fetchMeMock).not.toHaveBeenCalled();
  });

  it("falls back to the legacy URL RPC only when the key RPC is not deployed", async () => {
    rpcMock.mockResolvedValueOnce({
      error: {
        code: "PGRST202",
        message: "Could not find the function public.update_my_avatar_by_key in the schema cache",
      },
    });

    const result = await uploadAvatar(avatarSource());

    expect(rpcMock).toHaveBeenNthCalledWith(1, "update_my_avatar_by_key", {
      p_object_key: expect.stringMatching(/^avatars\/user-1\/[0-9a-f-]{36}\.jpg$/),
      p_avatar_url: expect.stringMatching(
        /^https:\/\/ref\.supabase\.co\/storage\/v1\/object\/public\/findback-images\/avatars\/user-1\//,
      ),
    });
    expect(rpcMock).toHaveBeenNthCalledWith(2, "update_my_avatar", {
      p_avatar_url: expect.stringMatching(
        /^https:\/\/ref\.supabase\.co\/storage\/v1\/object\/public\/findback-images\/avatars\/user-1\//,
      ),
    });
    expect(result).toBe(refreshed);
  });

  it("does not fall back when the key RPC fails for another reason", async () => {
    rpcMock.mockResolvedValueOnce({
      error: { message: "new row violates row-level security policy for table users" },
    });

    await expect(uploadAvatar(avatarSource())).rejects.toThrow(/could not save/i);

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(fetchMeMock).not.toHaveBeenCalled();
  });

  it("maps storage failures to a human upload error", async () => {
    uploadMock.mockResolvedValue({ error: { message: "bucket denied" } });

    await expect(uploadAvatar(avatarSource())).rejects.toThrow(/could not upload/i);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("deletes the previous avatar object only after the new URL is saved", async () => {
    const previous = "https://ref.supabase.co/storage/v1/object/public/findback-images/avatars/user-1/old.jpg";

    await uploadAvatar(avatarSource(), previous);

    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(removeMock).toHaveBeenCalledWith(["avatars/user-1/old.jpg"]);
  });

  it("never deletes a Google-seeded avatar from storage on replace", async () => {
    await uploadAvatar(avatarSource(), "https://lh3.googleusercontent.com/a/avatar");

    expect(removeMock).not.toHaveBeenCalled();
  });

  it("still resolves when previous-object cleanup throws", async () => {
    removeMock.mockRejectedValueOnce(new Error("cleanup boom"));
    const previous = "https://ref.supabase.co/storage/v1/object/public/findback-images/avatars/user-1/old.jpg";

    await expect(uploadAvatar(avatarSource(), previous)).resolves.toBe(refreshed);
  });
});

describe("removeAvatar", () => {
  it("clears the URL then removes the stored object", async () => {
    const current = "https://ref.supabase.co/storage/v1/object/public/findback-images/avatars/user-1/old.jpg";

    const result = await removeAvatar(current);

    expect(rpcMock).toHaveBeenCalledWith("update_my_avatar", { p_avatar_url: null });
    expect(removeMock).toHaveBeenCalledWith(["avatars/user-1/old.jpg"]);
    expect(result).toBe(refreshed);
  });

  it("resolves when there is no stored object to delete", async () => {
    await expect(removeAvatar("https://lh3.googleusercontent.com/a/avatar")).resolves.toBe(refreshed);
    await expect(removeAvatar(null)).resolves.toBe(refreshed);
    expect(rpcMock).toHaveBeenCalledTimes(2);
    expect(removeMock).not.toHaveBeenCalled();
  });
});

const REPO_ROOT = resolve(process.cwd(), "../..");
const AVATAR_SQL = resolve(REPO_ROOT, "supabase/migrations/20261010000000_profile_avatar.sql");

function avatarSql(): string {
  return readFileSync(AVATAR_SQL, "utf8");
}

/**
 * The migration auto-applies on push, so these pin the additive-safety
 * contract: no new bucket, owner-scoped prefix policies only, a self-only
 * SECURITY DEFINER writer that accepts solely our own avatar prefix, and no
 * table grants of any kind.
 */
describe("profile avatar migration", () => {
  it("adds owner-scoped Storage policies for the avatars prefix without touching report policies", () => {
    const text = avatarSql();
    expect(text).toMatch(/findback_images_avatar_select_own/i);
    expect(text).toMatch(/findback_images_avatar_insert_own/i);
    expect(text).toMatch(/findback_images_avatar_delete_own/i);
    expect(text).toMatch(/\(storage\.foldername\(name\)\)\[1\] = 'avatars'/i);
    expect(text).toMatch(/\(storage\.foldername\(name\)\)\[2\] = \(select auth\.uid\(\)\)::text/i);
    expect(text).not.toMatch(/insert into storage\.buckets/i);
    expect(text).not.toMatch(/drop table|drop column|delete from|truncate/i);
  });

  it("writes through a self-only SECURITY DEFINER RPC with a locked search_path", () => {
    const text = avatarSql();
    expect(text).toMatch(/create or replace function public\.update_my_avatar\(/i);
    expect(text).toMatch(/security definer\s+set search_path = public, pg_temp/i);
    expect(text).toMatch(/v_uid\s+text := public\.findback_uid\(\)/i);
    expect(text).toMatch(/update public\.users[\s\S]*where id = v_uid/i);
    expect(text).not.toMatch(/p_user_id|p_uid/i);
  });

  it("accepts only our own avatar prefix over https and clears on blank", () => {
    const text = avatarSql();
    expect(text).toMatch(/nullif\(btrim\(coalesce\(p_avatar_url, ''\)\), ''\)/i);
    expect(text).toMatch(/not like 'https:\/\/%'/i);
    expect(text).toMatch(/\/findback-images\/avatars\//i);
    expect(text).toMatch(/char_length\(v_avatar\) > 2048/i);
  });

  it("revokes the writer from anon and grants it only to authenticated, with no table grants", () => {
    const text = avatarSql();
    expect(text).toMatch(/revoke all on function public\.update_my_avatar\(text\) from public/i);
    expect(text).toMatch(/revoke execute on function public\.update_my_avatar\(text\) from anon/i);
    expect(text).toMatch(/grant execute on function public\.update_my_avatar\(text\) to authenticated/i);
    expect(text).not.toMatch(/grant (update|insert|delete) on/i);
  });

  it("uses the same bucket and prefix constants as the client", () => {
    expect(AVATAR_BUCKET).toBe("findback-images");
    expect(AVATAR_PREFIX).toBe("avatars");
    expect(avatarSql()).toMatch(/bucket_id = 'findback-images'/i);
  });
});

// ---------------------------------------------------------------------------
// W5-IDENTITY appended cases: owned object-key validation, the exact-key
// writer, and the migration pins for the UPDATE policy + key RPC.
// ---------------------------------------------------------------------------

describe("isValidAvatarObjectKey", () => {
  it("accepts exactly avatars/{uid}/{filename} with a still-image extension", () => {
    expect(isValidAvatarObjectKey("avatars/user-1/a.jpg", "user-1")).toBe(true);
    expect(isValidAvatarObjectKey("avatars/user-1/photo.jpeg", "user-1")).toBe(true);
    expect(isValidAvatarObjectKey("avatars/user-1/a.PNG", "user-1")).toBe(true);
    expect(isValidAvatarObjectKey("avatars/user-1/a.webp", "user-1")).toBe(true);
  });

  it("rejects foreign uids, traversal, wrong shapes, and non-stills", () => {
    expect(isValidAvatarObjectKey("avatars/user-2/a.jpg", "user-1")).toBe(false);
    expect(isValidAvatarObjectKey("avatars/user-1/../x.jpg", "user-1")).toBe(false);
    expect(isValidAvatarObjectKey("avatars/user-1/a.gif", "user-1")).toBe(false);
    expect(isValidAvatarObjectKey("avatars/user-1/a", "user-1")).toBe(false);
    expect(isValidAvatarObjectKey("avatars/user-1/", "user-1")).toBe(false);
    expect(isValidAvatarObjectKey("user-1/a.jpg", "user-1")).toBe(false);
    expect(isValidAvatarObjectKey("avatars/user-1/nested/a.jpg", "user-1")).toBe(false);
    expect(isValidAvatarObjectKey("", "user-1")).toBe(false);
    expect(isValidAvatarObjectKey("avatars/user-1/a.jpg", "")).toBe(false);
  });
});

describe("updateMyAvatarByKey", () => {
  const key = "avatars/user-1/a.jpg";
  const url = "https://ref.supabase.co/storage/v1/object/public/findback-images/avatars/user-1/a.jpg";

  it("writes through the exact-key RPC then reloads the profile", async () => {
    const result = await updateMyAvatarByKey(key, url);

    expect(rpcMock).toHaveBeenCalledWith("update_my_avatar_by_key", {
      p_object_key: key,
      p_avatar_url: url,
    });
    expect(fetchMeMock).toHaveBeenCalledTimes(1);
    expect(result).toBe(refreshed);
  });

  it("rejects foreign keys, traversal, and URL/key mismatches before the backend", async () => {
    await expect(updateMyAvatarByKey("avatars/user-2/a.jpg", url)).rejects.toThrow(/invalid/i);
    await expect(updateMyAvatarByKey("avatars/user-1/../x.jpg", url)).rejects.toThrow(/invalid/i);
    await expect(
      updateMyAvatarByKey(key, "https://ref.supabase.co/storage/v1/object/public/findback-images/avatars/user-2/a.jpg"),
    ).rejects.toThrow(/invalid/i);
    await expect(updateMyAvatarByKey(key, "http://ref.supabase.co/storage/v1/object/public/findback-images/avatars/user-1/a.jpg")).rejects.toThrow(
      /invalid/i,
    );
    expect(rpcMock).not.toHaveBeenCalled();
    expect(fetchMeMock).not.toHaveBeenCalled();
  });

  it("rejects lookalike-host URLs even when the key matches (FBX-022)", async () => {
    // Same key embedded, but the host is not our Storage host.
    await expect(
      updateMyAvatarByKey(
        key,
        "https://evil.example.com/storage/v1/object/public/findback-images/avatars/user-1/a.jpg",
      ),
    ).rejects.toThrow(/invalid/i);
    await expect(
      updateMyAvatarByKey(
        key,
        "https://ref.supabase.co.evil.com/storage/v1/object/public/findback-images/avatars/user-1/a.jpg",
      ),
    ).rejects.toThrow(/invalid/i);
    expect(rpcMock).not.toHaveBeenCalled();
    expect(fetchMeMock).not.toHaveBeenCalled();
  });

  it("rejects a same-host URL embedding a different key (FBX-022)", async () => {
    await expect(
      updateMyAvatarByKey(
        key,
        "https://ref.supabase.co/storage/v1/object/public/findback-images/avatars/user-1/other.jpg",
      ),
    ).rejects.toThrow(/invalid/i);
    expect(rpcMock).not.toHaveBeenCalled();
    expect(fetchMeMock).not.toHaveBeenCalled();
  });

  it("refuses without a session and maps RPC failures to a human save error", async () => {
    clientMock.auth.getUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    await expect(updateMyAvatarByKey(key, url)).rejects.toThrow(/sign in again/i);

    rpcMock.mockResolvedValue({ error: { message: "avatar object not found" } });
    await expect(updateMyAvatarByKey(key, url)).rejects.toThrow(/could not save your profile photo/i);
    expect(fetchMeMock).not.toHaveBeenCalled();
  });
});

const AVATAR_KEY_MIGRATION = "supabase/migrations/20261012000000_phone_cooldown_avatar_key.sql";

function avatarKeySql(): string {
  // Vitest may run from the repo root or apps/mobile — resolve by trial so
  // the contract holds from either cwd.
  for (const candidate of [AVATAR_KEY_MIGRATION, `../../${AVATAR_KEY_MIGRATION}`]) {
    try {
      return readFileSync(candidate, "utf8");
    } catch {
      // Not under this cwd — try the next candidate.
    }
  }
  throw new Error(`cannot locate ${AVATAR_KEY_MIGRATION} from cwd ${process.cwd()}`);
}

/**
 * The migration auto-applies on push; these pin the object-key discipline:
 * the missing owner-scoped UPDATE policy plus an exact-key writer that binds
 * the caller uid, rejects traversal, and verifies the Storage object exists.
 */
describe("avatar object-key migration", () => {
  it("adds the owner-scoped UPDATE policy for the avatars prefix", () => {
    const text = avatarKeySql();
    expect(text).toMatch(/findback_images_avatar_update_own/i);
    expect(text).toMatch(/for update to authenticated/i);
    expect(text).toMatch(/\(storage\.foldername\(name\)\)\[1\] = 'avatars'/i);
    expect(text).toMatch(/\(storage\.foldername\(name\)\)\[2\] = \(select auth\.uid\(\)\)::text/i);
  });

  it("writes through an exact-key SECURITY DEFINER RPC with a locked search_path", () => {
    const text = avatarKeySql();
    expect(text).toMatch(/create or replace function public\.update_my_avatar_by_key\(/i);
    expect(text).toMatch(/security definer\s+set search_path = public, pg_temp/i);
    expect(text).toMatch(/v_uid\s+text := public\.findback_uid\(\)/i);
    expect(text).toMatch(/update public\.users[\s\S]*where id = v_uid/i);
    expect(text).not.toMatch(/p_user_id|p_uid/i);
  });

  it("binds the key to the caller, rejects traversal, and verifies existence", () => {
    const text = avatarKeySql();
    expect(text).toMatch(/v_parts\[1\] <> 'avatars'/i);
    expect(text).toMatch(/v_parts\[2\] <> v_uid/i);
    expect(text).toMatch(/position\('..' in v_key\)/i);
    expect(text).toMatch(/storage\.objects/i);
    expect(text).toMatch(/avatar object not found/i);
    expect(text).toMatch(/\/findback-images\//i);
  });

  it("revokes the key writer from anon and grants it only to authenticated", () => {
    const text = avatarKeySql();
    expect(text).toMatch(/revoke all on function public\.update_my_avatar_by_key\(text, text\) from public/i);
    expect(text).toMatch(/revoke execute on function public\.update_my_avatar_by_key\(text, text\) from anon/i);
    expect(text).toMatch(/grant execute on function public\.update_my_avatar_by_key\(text, text\) to authenticated/i);
  });
});
