import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicUser } from "@findback/shared";

const { clientMock, fetchMeMock } = vi.hoisted(() => ({
  clientMock: { rpc: vi.fn() },
  fetchMeMock: vi.fn(),
}));

vi.mock("./supabaseClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./supabaseClient")>();
  return { ...actual, getSupabase: () => clientMock };
});

vi.mock("./auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth")>();
  return { ...actual, fetchMe: (...args: unknown[]) => fetchMeMock(...args) };
});

import { fetchPublicProfile, searchProfilesByPrefix, updateMyProfile } from "./profile";

const row = {
  id: "u2",
  username: "owner",
  avatar_url: null,
  email_verified: 1,
  phone_verified: 0,
  display_name: "Owner Name",
  bio: "I find things",
  location_label: "Dhaka",
  created_at: "2026-01-05T00:00:00.000Z",
};

beforeEach(() => {
  clientMock.rpc.mockReset();
  fetchMeMock.mockReset();
});

describe("fetchPublicProfile", () => {
  it("looks the handle up through the safe public RPC", async () => {
    clientMock.rpc.mockResolvedValue({ data: [row], error: null });

    const profile = await fetchPublicProfile("owner");

    expect(clientMock.rpc).toHaveBeenCalledWith("public_profile_by_username", {
      p_username: "owner",
    });
    expect(profile).toEqual({
      id: "u2",
      username: "owner",
      emailVerified: true,
      phoneVerified: false,
      avatarUrl: null,
      displayName: "Owner Name",
      bio: "I find things",
      locationLabel: "Dhaka",
      createdAt: "2026-01-05T00:00:00.000Z",
    });
  });

  it("never exposes email or phone in the mapped profile", async () => {
    clientMock.rpc.mockResolvedValue({ data: [row], error: null });

    const profile = await fetchPublicProfile("owner");

    expect(profile).not.toHaveProperty("email");
    expect(profile).not.toHaveProperty("phone");
  });

  it("reports a missing profile with a 404-shaped human error", async () => {
    clientMock.rpc.mockResolvedValue({ data: [], error: null });

    await expect(fetchPublicProfile("ghost")).rejects.toMatchObject({ status: 404 });
  });

  it("rejects a blank handle without touching the backend", async () => {
    await expect(fetchPublicProfile("   ")).rejects.toThrow();
    expect(clientMock.rpc).not.toHaveBeenCalled();
  });

  it("maps RPC transport failures to a human error", async () => {
    clientMock.rpc.mockResolvedValue({ data: null, error: { message: "boom", code: "400" } });

    await expect(fetchPublicProfile("owner")).rejects.toThrow(/could not be loaded/i);
  });
});

describe("updateMyProfile", () => {
  const refreshed: PublicUser = {
    id: "u1",
    username: "tester",
    email: "tester@example.com",
    phone: "+8801812345678",
    emailVerified: true,
    phoneVerified: false,
    avatarUrl: null,
    displayName: "New Name",
    bio: "hi",
    locationLabel: "Dhaka",
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  it("sends trimmed values through the self-update RPC then reloads the profile", async () => {
    clientMock.rpc.mockResolvedValue({ data: null, error: null });
    fetchMeMock.mockResolvedValue(refreshed);

    const result = await updateMyProfile({
      displayName: "  New Name ",
      bio: "  hi ",
      locationLabel: " Dhaka ",
    });

    expect(clientMock.rpc).toHaveBeenCalledWith("update_my_profile", {
      p_display_name: "New Name",
      p_bio: "hi",
      p_location_label: "Dhaka",
    });
    expect(fetchMeMock).toHaveBeenCalledTimes(1);
    expect(result).toBe(refreshed);
  });

  it("stores blank bio/location as null so the column is cleared", async () => {
    clientMock.rpc.mockResolvedValue({ data: null, error: null });
    fetchMeMock.mockResolvedValue(refreshed);

    await updateMyProfile({ displayName: "Name", bio: "   ", locationLabel: "" });

    expect(clientMock.rpc).toHaveBeenCalledWith("update_my_profile", {
      p_display_name: "Name",
      p_bio: null,
      p_location_label: null,
    });
  });

  it("requires a non-empty display name before calling the backend", async () => {
    await expect(updateMyProfile({ displayName: "   " })).rejects.toThrow(/display name/i);
    expect(clientMock.rpc).not.toHaveBeenCalled();
  });

  it("bounds display name, bio and location client-side", async () => {
    await expect(updateMyProfile({ displayName: "x".repeat(81) })).rejects.toThrow(/80/);
    await expect(updateMyProfile({ displayName: "ok", bio: "x".repeat(281) })).rejects.toThrow(/280/);
    await expect(updateMyProfile({ displayName: "ok", locationLabel: "x".repeat(61) })).rejects.toThrow(/60/);
    expect(clientMock.rpc).not.toHaveBeenCalled();
  });

  it("maps RPC failures to a human save error", async () => {
    clientMock.rpc.mockResolvedValue({ data: null, error: { message: "invalid bio", code: "22023" } });

    await expect(updateMyProfile({ displayName: "Name", bio: "hi" })).rejects.toThrow(
      /could not save/i,
    );
    expect(fetchMeMock).not.toHaveBeenCalled();
  });
});

const REPO_ROOT = resolve(process.cwd(), "../..");
const PREFIX_SEARCH_SQL = resolve(
  REPO_ROOT,
  "supabase/migrations/20261009040000_profile_prefix_search.sql",
);

function prefixSearchSql(): string {
  return readFileSync(PREFIX_SEARCH_SQL, "utf8");
}

/**
 * The prefix-search migration auto-applies on push, so these pin the
 * additive-safety contract: a new authenticated-only RPC, four safe columns,
 * a bounded prefix match, and no private contact columns anywhere.
 */
describe("profile prefix-search migration", () => {
  it("creates findback_search_profiles_client with a prefix arg and the 4 safe columns", () => {
    const text = prefixSearchSql();
    expect(text).toMatch(/create.+function public\.findback_search_profiles_client\(p_prefix text\)/i);
    expect(text).toMatch(/returns table \(/i);
    expect(text).toMatch(/\bid text\b/i);
    expect(text).toMatch(/\busername text\b/i);
    expect(text).toMatch(/\bdisplay_name text\b/i);
    expect(text).toMatch(/\bavatar_url text\b/i);
    expect(text).not.toMatch(/\bu\.email\b|\bu\.phone\b/i);
  });

  it("prefix-matches case-insensitively, orders by username, and bounds to 8 rows", () => {
    const text = prefixSearchSql();
    expect(text).toMatch(/lower\(u\.username\) like lower\(v_prefix\) \|\| '%'/i);
    expect(text).toMatch(/order by u\.username/i);
    expect(text).toMatch(/limit 8/i);
  });

  it("rejects anonymous callers and revokes anon execute", () => {
    const text = prefixSearchSql();
    expect(text).toMatch(/errcode = '28000'/i);
    expect(text).toMatch(
      /revoke execute on function public\.findback_search_profiles_client\(text\) from anon/i,
    );
    expect(text).toMatch(
      /grant execute on function public\.findback_search_profiles_client\(text\) to authenticated/i,
    );
  });

  it("is strictly additive with a locked search_path", () => {
    const text = prefixSearchSql();
    expect(text).not.toMatch(/drop table|drop column|delete from|truncate/i);
    expect(text).toMatch(/security definer\s+set search_path = public, pg_temp/i);
  });
});

describe("searchProfilesByPrefix", () => {
  it("short-circuits empty and single-char prefixes without calling the RPC", async () => {
    await expect(searchProfilesByPrefix("")).resolves.toEqual([]);
    await expect(searchProfilesByPrefix("   ")).resolves.toEqual([]);
    await expect(searchProfilesByPrefix("a")).resolves.toEqual([]);
    expect(clientMock.rpc).not.toHaveBeenCalled();
  });

  it("trims the prefix before querying the prefix-search RPC", async () => {
    clientMock.rpc.mockResolvedValue({ data: [], error: null });

    await searchProfilesByPrefix("  al ");

    expect(clientMock.rpc).toHaveBeenCalledWith("findback_search_profiles_client", {
      p_prefix: "al",
    });
  });

  it("maps rows to searched profiles without private fields", async () => {
    clientMock.rpc.mockResolvedValue({
      data: [{ id: "u9", username: "ali", display_name: "Ali", avatar_url: null }],
      error: null,
    });

    await expect(searchProfilesByPrefix("al")).resolves.toEqual([
      { id: "u9", username: "ali", displayName: "Ali", avatarUrl: null },
    ]);
  });

  it("propagates RPC failures instead of swallowing them", async () => {
    clientMock.rpc.mockResolvedValue({ data: null, error: { message: "boom", code: "400" } });

    await expect(searchProfilesByPrefix("al")).rejects.toThrow(/could not be searched/i);
  });
});
